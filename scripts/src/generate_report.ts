#!/usr/bin/env node
/**
 * generate_report.ts — Standalone CLI that reads pipeline artifacts for a given
 * run and renders an EVALUATION_REPORT.md.
 *
 * Usage:
 *   npx tsx scripts/src/generate_report.ts --docs <docs-dir> --run <runId> [--out <path>]
 *
 * Example:
 *   npx tsx scripts/src/generate_report.ts \
 *     --docs /tmp/bhm-at-scale-msc/docs \
 *     --run run-2026-02-26-17-21-39 \
 *     --out EVALUATION_REPORT.md
 *
 * The script reads:
 *   docs/.metrics/<runId>.metrics.json
 *   docs/.proposals/<runId>.json          (proposal)
 *   docs/.proposals/<runId>.decisions.json
 *   docs/ml_system_card.yaml
 *   docs/ml_system_card.anchors.json
 *   docs/.card_runs/*                     (receipt — auto-discovered)
 *   docs/.metrics/<runId>.faithfulness_sample.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { load as yamlParse } from "js-yaml";

// ── Argument parsing ────────────────────────────────────────────────

function parseArgs(): { docsDir: string; runId: string; outPath: string } {
  const args = process.argv.slice(2);
  let docsDir = "";
  let runId = "";
  let outPath = "EVALUATION_REPORT.md";

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--docs" || args[i] === "-d") && args[i + 1]) {
      docsDir = args[++i];
    } else if ((args[i] === "--run" || args[i] === "-r") && args[i + 1]) {
      runId = args[++i];
    } else if ((args[i] === "--out" || args[i] === "-o") && args[i + 1]) {
      outPath = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(
        `Usage: generate_report --docs <docs-dir> --run <runId> [--out <path>]\n\n` +
        `  --docs, -d   Path to the docs/ directory of the target repo\n` +
        `  --run,  -r   Run ID (e.g. run-2026-02-26-17-21-39)\n` +
        `  --out,  -o   Output markdown path (default: EVALUATION_REPORT.md)\n`
      );
      process.exit(0);
    }
  }

  if (!docsDir || !runId) {
    console.error("Error: --docs and --run are required. Use --help for usage.");
    process.exit(1);
  }
  return { docsDir, runId, outPath };
}

// ── Helpers ─────────────────────────────────────────────────────────

function readJSON(filePath: string): any {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function pct(n: number, digits = 1): string {
  return (n * 100).toFixed(digits) + " %";
}

function ms2human(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sRem = s % 60;
  if (m > 0) return `${ms.toLocaleString()} ms (${m} m ${sRem.toString().padStart(2, "0")} s)`;
  return `${ms.toLocaleString()} ms (${s} s)`;
}

function pctOfTotal(part: number, total: number): string {
  if (total === 0) return "—";
  return (part / total * 100).toFixed(1) + " %";
}

function getLeafNodes(obj: any, currentPath = "$"): { path: string; value: any }[] {
  let nodes: { path: string; value: any }[] = [];
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      nodes = nodes.concat(getLeafNodes(obj[i], `${currentPath}[${i}]`));
    }
  } else if (obj !== null && typeof obj === "object") {
    for (const key of Object.keys(obj)) {
      nodes = nodes.concat(getLeafNodes(obj[key], `${currentPath}.${key}`));
    }
  } else {
    nodes.push({ path: currentPath, value: obj });
  }
  return nodes;
}

function discoverReceipt(docsDir: string, runId: string): any | null {
  const cardRunsDir = path.join(docsDir, ".card_runs");
  if (!fs.existsSync(cardRunsDir)) return null;
  for (const f of fs.readdirSync(cardRunsDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const data = readJSON(path.join(cardRunsDir, f));
      if (data?.run_id === runId) return data;
    } catch { /* skip */ }
  }
  // Fall back: read first json
  const files = fs.readdirSync(cardRunsDir).filter((f: string) => f.endsWith(".json"));
  if (files.length > 0) return readJSON(path.join(cardRunsDir, files[0]));
  return null;
}

// ── Schema fill-rate computation ────────────────────────────────────

interface FillRate { section: string; filled: number; total: number; notes: string }

function computeSchemaFillRate(yamlPath: string): { rates: FillRate[]; totalFilled: number; totalFields: number } {
  if (!fs.existsSync(yamlPath)) return { rates: [], totalFilled: 0, totalFields: 0 };
  const card = yamlParse(fs.readFileSync(yamlPath, "utf-8")) as Record<string, unknown>;
  if (!card || typeof card !== "object") return { rates: [], totalFilled: 0, totalFields: 0 };

  const SKIP_SECTIONS = new Set(["ai"]);
  const rates: FillRate[] = [];
  let totalFilled = 0;
  let totalFields = 0;

  for (const section of Object.keys(card)) {
    if (SKIP_SECTIONS.has(section)) continue;
    const sectionObj = card[section];
    if (sectionObj === null || sectionObj === undefined) {
      rates.push({ section, filled: 0, total: 1, notes: "Empty" });
      totalFields += 1;
      continue;
    }
    const leaves = getLeafNodes(sectionObj, `$.${section}`);
    const filled = leaves.filter(
      (l) => l.value !== null && l.value !== undefined && l.value !== "" &&
        !(Array.isArray(l.value) && l.value.length === 0)
    ).length;
    rates.push({ section, filled, total: leaves.length, notes: "" });
    totalFilled += filled;
    totalFields += leaves.length;
  }

  return { rates, totalFilled, totalFields };
}

// ── Anchor stats ────────────────────────────────────────────────────

function computeAnchorStats(anchorsData: any): { anchoredPaths: number; totalAnchors: number; topFiles: { file: string; count: number }[] } {
  if (!anchorsData?.anchorsByPath) return { anchoredPaths: 0, totalAnchors: 0, topFiles: [] };
  const byPath = anchorsData.anchorsByPath as Record<string, any[]>;
  const anchoredPaths = Object.keys(byPath).length;
  let totalAnchors = 0;
  const fileCounts = new Map<string, number>();

  for (const anchors of Object.values(byPath)) {
    for (const a of anchors) {
      totalAnchors++;
      const p = a.path || "unknown";
      fileCounts.set(p, (fileCounts.get(p) || 0) + 1);
    }
  }

  const topFiles = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, count]) => ({ file, count }));

  return { anchoredPaths, totalAnchors, topFiles };
}

// ── Confidence distribution ─────────────────────────────────────────

interface ConfBand { band: string; count: number; examples: string }

function computeConfidenceDistribution(crRows: any[]): { bands: ConfBand[]; mean: number; min: number; max: number } {
  if (!crRows || crRows.length === 0) return { bands: [], mean: 0, min: 0, max: 0 };
  const high: any[] = [];
  const mid: any[] = [];
  const low: any[] = [];

  for (const r of crRows) {
    const c = r.confidence ?? 0;
    if (c >= 0.80) high.push(r);
    else if (c >= 0.40) mid.push(r);
    else low.push(r);
  }

  const fmt = (rows: any[]) =>
    rows.slice(0, 8).map((r: any) => `\`${r.jsonPath}\` (${r.confidence})`).join(", ");
  const confs = crRows.map((r: any) => r.confidence ?? 0);

  return {
    bands: [
      { band: "**High** (≥ 0.80)", count: high.length, examples: fmt(high) },
      { band: "**Mid** (0.40 – 0.79)", count: mid.length, examples: fmt(mid) },
      { band: "**Low** (< 0.40)", count: low.length, examples: fmt(low) },
    ],
    mean: confs.reduce((a: number, b: number) => a + b, 0) / confs.length,
    min: Math.min(...confs),
    max: Math.max(...confs),
  };
}

// ── Main report builder ─────────────────────────────────────────────

function generateReport(docsDir: string, runId: string): string {
  // Load artifacts
  const m = readJSON(path.join(docsDir, ".metrics", `${runId}.metrics.json`));
  const proposal = readJSON(path.join(docsDir, ".proposals", `${runId}.json`));
  const decisionsRaw = readJSON(path.join(docsDir, ".proposals", `${runId}.decisions.json`));
  const anchorsData = readJSON(path.join(docsDir, "ml_system_card.anchors.json"));
  const receipt = discoverReceipt(docsDir, runId);
  const faithfulness = readJSON(path.join(docsDir, ".metrics", `${runId}.faithfulness_sample.json`));
  const yamlPath = path.join(docsDir, "ml_system_card.yaml");

  if (!m) {
    console.error(`Metrics file not found at ${path.join(docsDir, ".metrics", `${runId}.metrics.json`)}`);
    process.exit(1);
  }

  const decisions: any[] = Array.isArray(decisionsRaw) ? decisionsRaw : decisionsRaw?.decisions || [];
  const crRows = proposal?.confidence_report || [];
  const notes = proposal?.notes || {};
  const lowConfRows = receipt?.low_confidence_rows_only || [];
  const changedPaths = receipt?.changed_paths || [];

  // Computed values
  const anchorStats = computeAnchorStats(anchorsData);
  const confDist = computeConfidenceDistribution(crRows);
  const fillRate = computeSchemaFillRate(yamlPath);
  const totalLatencyHuman = ms2human(m.total_latency_ms ?? 0);
  const runDate = runId.replace(/^run-/, "").replace(/-\d{2}-\d{2}-\d{2}$/, "");

  // M5 recompute
  let m5Num = m.accepted_nontrivial_with_anchor_count ?? 0;
  let m5Den = m.accepted_nontrivial_count ?? 0;
  let m5Val = m5Den > 0 ? (m5Num / m5Den).toFixed(3) : "0";
  // M6 recompute
  let m6Num = m.resolvable_anchor_count ?? 0;
  let m6Den = m.total_evaluated_anchor_count ?? 0;
  let m6Val = m6Den > 0 ? (m6Num / m6Den).toFixed(3) : "0";
  // M7
  let m7Num = m.populated_leaf_anchored_count ?? 0;
  let m7Den = m.populated_leaf_count ?? 0;
  let m7Val = m7Den > 0 ? pct(m7Num / m7Den) : "0 %";

  // ── Build Markdown ────────────────────────────────────────────────

  const lines: string[] = [];
  const w = (...s: string[]) => lines.push(...s);

  w(`# ML System Card — Evaluation Report`);
  w(``);
  w(`**Run:** \`${runId}\``);
  w(`**Date:** ${runDate}`);
  w(`**LLM:** ${m.llm_model || "unknown"}`);
  w(`**Generated:** ${m.generated_at || "—"}`);
  w(``);
  w(`---`);
  w(``);

  // ── Section 1: Executive Summary ──
  w(`## 1 Executive Summary`);
  w(``);
  w(`The pipeline ${m.apply_success ? "successfully" : "**FAILED** to"} generate and apply an ML System Card.`);
  w(`The card populates **${m7Den} leaf fields** from **${m.facts_total ?? "?"} facts**.`);
  if (fillRate.totalFields > 0) {
    w(`Schema fill rate: **${fillRate.totalFilled} / ${fillRate.totalFields} (${pct(fillRate.totalFilled / fillRate.totalFields)})**.`);
  }
  w(`Total wall-clock time: **${totalLatencyHuman}** at an estimated cost of **$${(m.estimated_cost_usd ?? 0).toFixed(2)}**.`);
  w(`Schema validation: ${m.schema_valid ? "**passed** ✅" : "**failed** ❌"} | Apply: ${m.apply_success ? "**success** ✅" : "**failed** ❌"} (${m.apply_attempts_until_success ?? "?"} attempt(s)).`);
  w(``);
  w(`---`);
  w(``);

  // ── Section 2: Metrics Framework ──
  w(`## 2 Metrics Framework (M1 – M16)`);
  w(``);

  // 2.1 Structural Integrity
  w(`### 2.1 Structural Integrity`);
  w(``);
  w(`| Metric | ID | Value | Interpretation |`);
  w(`|---|---|---|---|`);
  w(`| **Schema valid** | M1 | \`${m.schema_valid ?? "?"}\` | ${m.schema_valid ? "Conforms to schema." : "Does NOT conform."} |`);
  w(`| **Apply success** | M2 | \`${m.apply_success ?? "?"}\` | ${m.apply_success ? "Card applied without errors." : "Apply failed."} |`);
  w(`| **Blocked reason** | M3 | ${m.blocked_reason || "—"} | ${m.blocked_reason ? "Run was blocked." : "No blocking condition."} |`);
  w(`| **YAML hash** | M4 | \`${(m.yaml_hash || "—").slice(0, 10)}…\` | SHA-256 fingerprint. |`);
  w(`| **Apply attempts** | M13 | \`${m.apply_attempts_until_success ?? "?"}\` | ${(m.apply_attempts_until_success ?? 1) === 1 ? "First-attempt success." : `Required ${m.apply_attempts_until_success} attempts.`} |`);
  w(``);

  // 2.2 Anchor Quality
  w(`### 2.2 Anchor Quality`);
  w(``);
  w(`| Metric | ID | Value | Interpretation |`);
  w(`|---|---|---|---|`);
  w(`| **Anchor compliance (nontrivial)** | M5 | **${m5Num} / ${m5Den} = ${m5Val}** | ${m5Den > 0 ? `${m5Num} of ${m5Den} accepted nontrivial facts have ≥1 anchor.` : "No nontrivial accepted facts."} |`);
  w(`| **Anchor resolvability** | M6 | **${m6Num} / ${m6Den} = ${m6Val}** | ${m6Den > 0 ? `${m6Num} of ${m6Den} anchors resolvable via git cat-file.` : "No anchors evaluated."} |`);
  w(`| **Anchored field coverage (leaf)** | M7 | **${m7Val}** (${m7Num} / ${m7Den}) | ${m7Num} populated leaves have matching anchors. |`);
  w(``);

  // 2.3 Faithfulness Sampling
  w(`### 2.3 Faithfulness Sampling`);
  w(``);
  if (faithfulness && faithfulness.length > 0) {
    w(`| Card Path | Verdict | Snippet |`);
    w(`|---|---|---|`);
    for (const sample of faithfulness) {
      w(`| \`${sample.jsonPath}\` | ${sample.verdict} | ${(sample.snippet || "").slice(0, 80)} |`);
    }
  } else {
    w(`| Metric | ID | Value |`);
    w(`|---|---|---|`);
    w(`| **Faithfulness sample** | M8 | \`[]\` (empty — no samples produced for this run) |`);
  }
  w(``);

  // 2.4 Fact & Gate Distribution
  w(`### 2.4 Fact & Gate Distribution`);
  w(``);
  w(`| Metric | ID | Value | Interpretation |`);
  w(`|---|---|---|---|`);
  w(`| **Facts total** | M9 | **${m.facts_total ?? "?"}** | Distinct card fields proposed. |`);
  w(`| **Gate OK** | M10 | **${m.gate_ok_count ?? 0} (${pct(m.gate_ok_pct ?? 0)})** | High-confidence facts. |`);
  w(`| **Gate Warn** | M10 | **${m.gate_warn_count ?? 0} (${pct(m.gate_warn_pct ?? 0)})** | Medium-confidence. |`);
  w(`| **Gate Require** | M10 | **${m.gate_require_count ?? 0} (${pct(m.gate_require_pct ?? 0)})** | Low-confidence (auto-rejected). |`);
  w(``);

  if (confDist.bands.length > 0) {
    w(`#### Confidence Distribution`);
    w(``);
    w(`| Band | Count | Examples |`);
    w(`|---|---|---|`);
    for (const b of confDist.bands) {
      w(`| ${b.band} | **${b.count}** | ${b.examples} |`);
    }
    w(``);
    w(`**Mean confidence: ${confDist.mean.toFixed(2)}** | Min: ${confDist.min} | Max: ${confDist.max}`);
    w(``);
  }

  // 2.5 Provenance Breakdown
  w(`### 2.5 Provenance Breakdown`);
  w(``);
  w(`| Metric | ID | Value |`);
  w(`|---|---|---|`);
  w(`| **Extracted** | M11 | **${m.provenance_extracted_count ?? 0} (${pct(m.provenance_extracted_pct ?? 0)})** |`);
  w(`| **Inferred** | M11 | **${m.provenance_inferred_count ?? 0} (${pct(m.provenance_inferred_pct ?? 0)})** |`);
  w(`| **Manual** | M11 | **${m.provenance_manual_count ?? 0} (${pct(m.provenance_manual_pct ?? 0)})** |`);
  w(``);

  // 2.6 Decision Outcomes
  w(`### 2.6 Decision Outcomes`);
  w(``);
  w(`| Metric | ID | Value |`);
  w(`|---|---|---|`);
  w(`| **Accepted** | M12 | **${m.decision_accepted_count ?? 0} (${pct(m.decision_accepted_pct ?? 0)})** |`);
  w(`| **Edited** | M12 | **${m.decision_edited_count ?? 0} (${pct(m.decision_edited_pct ?? 0)})** |`);
  w(`| **Rejected** | M12 | **${m.decision_rejected_count ?? 0} (${pct(m.decision_rejected_pct ?? 0)})** |`);
  w(`| **Undecided** | M12 | **${m.decision_undecided_count ?? 0} (${pct(m.decision_undecided_pct ?? 0)})** |`);
  w(``);

  // 2.7 Diff Impact
  w(`### 2.7 Diff Impact`);
  w(``);
  w(`| Metric | ID | Value |`);
  w(`|---|---|---|`);
  w(`| **Added lines** | M14 | **${m.added_lines ?? 0}** |`);
  w(`| **Removed lines** | M14 | **${m.removed_lines ?? 0}** |`);
  w(`| **Total diff lines** | M14 | **${m.msc_diff_lines ?? 0}** |`);
  w(``);

  // 2.8 Section Coverage
  w(`### 2.8 Section Coverage (M15 / M16)`);
  w(``);
  if (m.expected_section_hit_rate != null) {
    w(`| Metric | ID | Value |`);
    w(`|---|---|---|`);
    w(`| **Expected section hit rate** | M15 | **${pct(m.expected_section_hit_rate)}** |`);
    w(`| **Off-target sections** | M16 | **${m.off_target_section_count ?? 0}** (${(m.off_target_sections || []).join(", ")}) |`);
  } else {
    w(`M15/M16 not computed — no \`.expectations.json\` file was provided.`);
  }
  w(``);

  // 2.9 Schema Fill Rate
  if (fillRate.rates.length > 0) {
    w(`### 2.9 Schema Fill Rate`);
    w(``);
    w(`| Section | Filled | Total | % |`);
    w(`|---|---|---|---|`);
    for (const r of fillRate.rates) {
      const p = r.total > 0 ? pct(r.filled / r.total, 0) : "0 %";
      w(`| \`${r.section}\` | ${r.filled} | ${r.total} | **${p}** |`);
    }
    w(``);
    w(`**Overall: ${fillRate.totalFilled} / ${fillRate.totalFields} = ${pct(fillRate.totalFilled / fillRate.totalFields)}**`);
    w(``);
  }

  w(`---`);
  w(``);

  // ── Section 3: LLM Telemetry ──
  w(`## 3 LLM Telemetry`);
  w(``);
  w(`### 3.1 Aggregate Performance`);
  w(``);
  w(`| Metric | Value |`);
  w(`|---|---|`);
  w(`| **Total wall-clock latency** | **${totalLatencyHuman}** |`);
  w(`| **Total prompt tokens** | **${(m.total_prompt_tokens ?? 0).toLocaleString()}** |`);
  w(`| **Total completion tokens** | **${(m.total_completion_tokens ?? 0).toLocaleString()}** |`);
  w(`| **Total tokens** | **${(m.total_tokens ?? 0).toLocaleString()}** |`);
  w(`| **Total retries** | **${m.total_retries ?? 0}** |`);
  w(`| **Estimated cost** | **$${(m.estimated_cost_usd ?? 0).toFixed(3)}** |`);
  w(`| **Model** | ${m.llm_model || "unknown"} |`);
  w(``);

  // Per-pass breakdown
  const passes = ["extractor", "reasoner", "verifier", "notes"];
  const hasPasses = passes.some((p) => m[`pass_${p}_latency_ms`] != null);
  if (hasPasses) {
    w(`### 3.2 Per-Pass Breakdown`);
    w(``);
    w(`| Pass | Latency | Prompt Tokens | Completion Tokens | % of Total Time |`);
    w(`|---|---|---|---|---|`);
    for (const p of passes) {
      const lat = m[`pass_${p}_latency_ms`];
      if (lat == null) continue;
      const pt = m[`pass_${p}_prompt_tokens`] ?? 0;
      const ct = m[`pass_${p}_completion_tokens`] ?? 0;
      w(`| **${p.charAt(0).toUpperCase() + p.slice(1)}** | ${ms2human(lat)} | ${pt.toLocaleString()} | ${ct.toLocaleString()} | ${pctOfTotal(lat, m.total_latency_ms ?? 1)} |`);
    }
    w(``);
  }

  w(`---`);
  w(``);

  // ── Section 4: Receipt & Provenance ──
  if (receipt) {
    w(`## 4 Receipt & Provenance Artifacts`);
    w(``);
    w(`| Field | Value |`);
    w(`|---|---|`);
    w(`| **Engine** | \`${receipt.engine}\` |`);
    w(`| **Run ID** | \`${receipt.run_id}\` |`);
    w(`| **Schema** | \`${receipt.schema_id}\` |`);
    w(`| **Timestamp** | \`${receipt.timestamp}\` |`);
    w(`| **Coverage (non-null)** | ${receipt.coverage_non_null} |`);
    w(`| **Changed paths** | ${changedPaths.length} |`);
    w(`| **YAML hash** | \`${(receipt.yaml_hash || "").slice(0, 16)}…\` |`);
    w(``);

    // Low-confidence rejections
    if (lowConfRows.length > 0) {
      w(`### 4.1 Low-Confidence Rejections`);
      w(``);
      w(`| Card Path | Confidence | Disposition |`);
      w(`|---|---|---|`);
      for (const row of lowConfRows) {
        w(`| \`${row.path}\` | ${row.confidence} | ${row.disposition} |`);
      }
      w(``);
    }
  }

  // ── Anchor stats ──
  if (anchorStats.totalAnchors > 0) {
    w(`### 4.2 Anchors`);
    w(``);
    w(`| Stat | Value |`);
    w(`|---|---|`);
    w(`| **Anchored card paths** | ${anchorStats.anchoredPaths} |`);
    w(`| **Total anchors** | ${anchorStats.totalAnchors} |`);
    w(`| **Unique source files** | ${anchorStats.topFiles.length}+ |`);
    w(``);
    w(`**Top-referenced source files:**`);
    w(``);
    w(`| File | Anchor Count |`);
    w(`|---|---|`);
    for (const f of anchorStats.topFiles) {
      w(`| \`${f.file}\` | ${f.count} |`);
    }
    w(``);
  }

  w(`---`);
  w(``);

  // ── Section 5: Stakeholder Notes ──
  const noteRoles = Object.keys(notes);
  if (noteRoles.length > 0) {
    w(`## 5 Stakeholder Notes`);
    w(``);
    w(`The \`notes\` pass generated summaries for **${noteRoles.length} stakeholder roles**:`);
    w(``);
    w(`| Role | Summary Preview |`);
    w(`|---|---|`);
    for (const role of noteRoles) {
      const raw = notes[role];
      const text = typeof raw === "string" ? raw : (raw?.overview || raw?.textMd || JSON.stringify(raw));
      w(`| **${role}** | ${text.slice(0, 80).replace(/\|/g, "\\|")}… |`);
    }
    w(``);
    w(`---`);
    w(``);
  }

  // ── Section 6: Summary Table ──
  w(`## 6 Summary Table`);
  w(``);
  w(`| # | Metric | Value | Status |`);
  w(`|---|---|---|---|`);
  w(`| M1 | Schema valid | ${m.schema_valid ?? "?"} | ${m.schema_valid ? "✅" : "❌"} |`);
  w(`| M2 | Apply success | ${m.apply_success ?? "?"} | ${m.apply_success ? "✅" : "❌"} |`);
  w(`| M3 | Blocked reason | ${m.blocked_reason || "—"} | ✅ |`);
  w(`| M4 | YAML hash | \`${(m.yaml_hash || "—").slice(0, 10)}…\` | ✅ |`);
  w(`| M5 | Anchor compliance (nontrivial) | **${m5Val}** (${m5Num}/${m5Den}) | ${m5Den > 0 && m5Num === m5Den ? "✅" : "⚠️"} |`);
  w(`| M6 | Anchor resolvability | **${m6Val}** (${m6Num}/${m6Den}) | ${m6Den > 0 && m6Num === m6Den ? "✅" : m6Den > 0 ? "⚠️" : "⬜"} |`);
  w(`| M7 | Anchored field coverage | **${m7Val}** | ${(m7Num / (m7Den || 1)) > 0.9 ? "✅" : "⚠️"} |`);
  w(`| M8 | Faithfulness sample | ${faithfulness?.length ? `${faithfulness.length} samples` : "empty"} | ${faithfulness?.length ? "✅" : "⬜"} |`);
  w(`| M9 | Facts total | ${m.facts_total ?? "?"} | ✅ |`);
  w(`| M10 | Gate OK / Warn / Require | ${pct(m.gate_ok_pct ?? 0)} / ${pct(m.gate_warn_pct ?? 0)} / ${pct(m.gate_require_pct ?? 0)} | ✅ |`);
  w(`| M11 | Extracted / Inferred / Manual | ${pct(m.provenance_extracted_pct ?? 0)} / ${pct(m.provenance_inferred_pct ?? 0)} / ${pct(m.provenance_manual_pct ?? 0)} | ✅ |`);
  w(`| M12 | Accepted / Edited / Rejected | ${pct(m.decision_accepted_pct ?? 0)} / ${pct(m.decision_edited_pct ?? 0)} / ${pct(m.decision_rejected_pct ?? 0)} | ✅ |`);
  w(`| M13 | Apply attempts | ${m.apply_attempts_until_success ?? "?"} | ✅ |`);
  w(`| M14 | Diff lines (added / removed) | ${m.msc_diff_lines ?? 0} (${m.added_lines ?? 0} / ${m.removed_lines ?? 0}) | ✅ |`);
  w(`| M15 | Section hit rate | ${m.expected_section_hit_rate != null ? pct(m.expected_section_hit_rate) : "—"} | ${m.expected_section_hit_rate != null ? "✅" : "⬜"} |`);
  w(`| M16 | Off-target sections | ${m.off_target_section_count ?? "—"} | ${m.off_target_section_count != null ? "✅" : "⬜"} |`);
  w(`| — | Total latency | ${totalLatencyHuman} | ✅ |`);
  w(`| — | Total tokens | ${(m.total_tokens ?? 0).toLocaleString()} | ✅ |`);
  w(`| — | Estimated cost | $${(m.estimated_cost_usd ?? 0).toFixed(3)} | ✅ |`);
  w(`| — | LLM retries | ${m.total_retries ?? 0} | ✅ |`);
  w(``);
  w(`---`);
  w(``);
  w(`*Report auto-generated by \`generate_report.ts\` from run \`${runId}\`.*`);

  return lines.join("\n");
}

// ── CLI entry point ─────────────────────────────────────────────────

const { docsDir, runId, outPath } = parseArgs();
const report = generateReport(docsDir, runId);
fs.writeFileSync(outPath, report, "utf-8");
console.log(`✅ Report written to ${outPath} (${report.length.toLocaleString()} chars)`);
