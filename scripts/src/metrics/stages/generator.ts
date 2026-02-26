import * as fs from "fs";
import * as path from "path";
import { writeMetrics } from "../storage.js";

// ── Cost estimation (USD per 1 M tokens) ──────────────────────────────
// Keep this table up-to-date when switching models.
const MODEL_PRICING: Record<string, { promptPer1M: number; completionPer1M: number }> = {
  "gpt-4o":           { promptPer1M: 2.50,  completionPer1M: 10.00 },
  "gpt-4o-mini":      { promptPer1M: 0.15,  completionPer1M: 0.60  },
  "gpt-4-turbo":      { promptPer1M: 10.00, completionPer1M: 30.00 },
  "gpt-4":            { promptPer1M: 30.00, completionPer1M: 60.00 },
  "gpt-3.5-turbo":    { promptPer1M: 0.50,  completionPer1M: 1.50  },
  "gpt-5.1":          { promptPer1M: 2.00,  completionPer1M: 8.00  },
  "o3-mini":          { promptPer1M: 1.10,  completionPer1M: 4.40  },
};

function estimateCostUsd(
  model: string | null | undefined,
  promptTokens: number,
  completionTokens: number
): number | undefined {
  if (!model) return undefined;
  const key = Object.keys(MODEL_PRICING).find(
    (k) => model.toLowerCase().startsWith(k)
  );
  if (!key) return undefined;
  const p = MODEL_PRICING[key];
  return (promptTokens / 1_000_000) * p.promptPer1M +
         (completionTokens / 1_000_000) * p.completionPer1M;
}

export async function runGeneratorStage(runId: string) {
  const proposalPath = path.join(process.cwd(), "docs", ".proposals", `${runId}.json`);

  if (!fs.existsSync(proposalPath)) {
    console.warn(`Proposal file not found: ${proposalPath}`);
    return;
  }

  const proposal = JSON.parse(fs.readFileSync(proposalPath, "utf-8"));
  const facts = proposal.facts || [];

  // ── Fact / gate / provenance counts (M9-M11) ───────────────────────
  const facts_total = facts.length;

  let gate_ok_count = 0;
  let gate_warn_count = 0;
  let gate_require_count = 0;

  let provenance_extracted_count = 0;
  let provenance_inferred_count = 0;
  let provenance_manual_count = 0;

  for (const fact of facts) {
    if (fact.gate === "OK") gate_ok_count++;
    else if (fact.gate === "Warn") gate_warn_count++;
    else if (fact.gate === "Require") gate_require_count++;

    const kind = fact.source?.kind;
    if (kind === "extracted") provenance_extracted_count++;
    else if (kind === "inferred") provenance_inferred_count++;
    else if (kind === "manual") provenance_manual_count++;
  }

  const gate_ok_pct = facts_total > 0 ? gate_ok_count / facts_total : 0;
  const gate_warn_pct = facts_total > 0 ? gate_warn_count / facts_total : 0;
  const gate_require_pct = facts_total > 0 ? gate_require_count / facts_total : 0;

  const provenance_extracted_pct = facts_total > 0 ? provenance_extracted_count / facts_total : 0;
  const provenance_inferred_pct = facts_total > 0 ? provenance_inferred_count / facts_total : 0;
  const provenance_manual_pct = facts_total > 0 ? provenance_manual_count / facts_total : 0;

  // ── Telemetry from proposal.meta ────────────────────────────────────
  const telemetry = proposal.meta?.telemetry;
  const total_latency_ms       = telemetry?.latencyMs       ?? undefined;
  const total_prompt_tokens     = telemetry?.tokens?.prompt     ?? undefined;
  const total_completion_tokens = telemetry?.tokens?.completion ?? undefined;
  const total_tokens            = telemetry?.tokens?.total      ?? undefined;
  const total_retries           = telemetry?.retries            ?? undefined;

  const llm_model    = proposal.meta?.provenance?.model       ?? undefined;
  const generated_at = proposal.meta?.provenance?.generatedAt ?? undefined;

  // ── Per-pass breakdown (stored in proposal.meta.passTelemetry) ─────
  const passes = proposal.meta?.passTelemetry;
  const pass_extractor_latency_ms        = passes?.extractor?.latencyMs        ?? undefined;
  const pass_extractor_prompt_tokens     = passes?.extractor?.promptTokens     ?? undefined;
  const pass_extractor_completion_tokens = passes?.extractor?.completionTokens ?? undefined;
  const pass_reasoner_latency_ms         = passes?.reasoner?.latencyMs         ?? undefined;
  const pass_reasoner_prompt_tokens      = passes?.reasoner?.promptTokens      ?? undefined;
  const pass_reasoner_completion_tokens  = passes?.reasoner?.completionTokens  ?? undefined;
  const pass_verifier_latency_ms         = passes?.verifier?.latencyMs         ?? undefined;
  const pass_verifier_prompt_tokens      = passes?.verifier?.promptTokens      ?? undefined;
  const pass_verifier_completion_tokens  = passes?.verifier?.completionTokens  ?? undefined;
  const pass_notes_latency_ms            = passes?.notes?.latencyMs            ?? undefined;
  const pass_notes_prompt_tokens         = passes?.notes?.promptTokens         ?? undefined;
  const pass_notes_completion_tokens     = passes?.notes?.completionTokens     ?? undefined;

  // ── Cost estimate ──────────────────────────────────────────────────
  const estimated_cost_usd = estimateCostUsd(
    llm_model,
    total_prompt_tokens ?? 0,
    total_completion_tokens ?? 0
  );

  writeMetrics(runId, {
    facts_total,
    gate_ok_count,
    gate_warn_count,
    gate_require_count,
    gate_ok_pct,
    gate_warn_pct,
    gate_require_pct,
    provenance_extracted_count,
    provenance_inferred_count,
    provenance_manual_count,
    provenance_extracted_pct,
    provenance_inferred_pct,
    provenance_manual_pct,
    total_latency_ms,
    total_prompt_tokens,
    total_completion_tokens,
    total_tokens,
    total_retries,
    estimated_cost_usd,
    pass_extractor_latency_ms,
    pass_extractor_prompt_tokens,
    pass_extractor_completion_tokens,
    pass_reasoner_latency_ms,
    pass_reasoner_prompt_tokens,
    pass_reasoner_completion_tokens,
    pass_verifier_latency_ms,
    pass_verifier_prompt_tokens,
    pass_verifier_completion_tokens,
    pass_notes_latency_ms,
    pass_notes_prompt_tokens,
    pass_notes_completion_tokens,
    llm_model,
    generated_at,
    proposal_path: proposalPath,
  });
}
