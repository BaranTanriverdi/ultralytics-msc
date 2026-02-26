import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { writeMetrics, readMetrics } from "../storage.js";
import { validateCardArtifacts } from "../../validate_card.js";
import { load as yamlParse } from "js-yaml";

function isLeaf(value: any): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object") return true;
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return Object.keys(value).length === 0;
}

function getLeafNodes(obj: any, currentPath: string = "$"): {path: string, value: any}[] {
  let nodes: {path: string, value: any}[] = [];
  if (isLeaf(obj)) {
    nodes.push({path: currentPath, value: obj});
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      nodes = nodes.concat(getLeafNodes(obj[i], `${currentPath}[${i}]`));
    }
  } else if (typeof obj === "object") {
    for (const key in obj) {
      // Handle keys with special characters if needed, but standard dot notation is fine for simple keys
      const nextPath = /^[a-zA-Z0-9_]+$/.test(key) ? `${currentPath}.${key}` : `${currentPath}["${key}"]`;
      nodes = nodes.concat(getLeafNodes(obj[key], nextPath));
    }
  }
  return nodes;
}

function isTrivial(path: string, value: any): boolean {
  // Trivial if path is within designated provenance/meta keys
  if (path.includes(".ai.fieldMeta") || path.includes(".ai.notes")) return true;
  // Trivial if value is pure explicit absence bookkeeping
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || (typeof value === "object" && Object.keys(value).length === 0)) {
    return true;
  }
  return false;
}

function checkAnchorResolvability(anchor: any, sha: string): boolean {
  try {
    // git cat-file -e <sha>:<path>
    execSync(`git cat-file -e ${sha}:${anchor.path}`, { stdio: "ignore" });

    // Check if requested line range can be read
    const blob = execSync(`git cat-file -p ${sha}:${anchor.path}`, { encoding: "utf-8" });
    const lines = blob.split("\n");
    if (anchor.startLine > 0 && anchor.endLine <= lines.length) {
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

export async function runApplyStage(runId: string, baseSha?: string, headSha?: string, applyFailed?: boolean) {
  const docsDir = path.join(process.cwd(), "docs");
  const yamlPath = path.join(docsDir, "ml_system_card.yaml");
  const anchorsPath = path.join(docsDir, "ml_system_card.anchors.json");

  // Find the latest micro-receipt for this runId
  const runsDir = path.join(docsDir, ".card_runs");
  let receiptPath = "";
  let receiptData: any = null;
  if (fs.existsSync(runsDir)) {
    const files = fs.readdirSync(runsDir).filter(f => f.endsWith(".json")).sort().reverse();
    for (const file of files) {
      const p = path.join(runsDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(p, "utf-8"));
        if (data.run_id === runId) {
          receiptPath = p;
          receiptData = data;
          break;
        }
      } catch (e) {
        // ignore parse errors
      }
    }
  }

  const apply_success = applyFailed ? 0 : (fs.existsSync(yamlPath) && fs.existsSync(anchorsPath) && receiptPath !== "" ? 1 : 0);

  let schema_valid = 0;
  let yaml_hash = "";

  if (apply_success) {
    try {
      const validationResult = await validateCardArtifacts();
      schema_valid = validationResult.schemaValid ? 1 : 0;
      yaml_hash = receiptData?.yaml_hash || "";
    } catch (e) {
      console.error("Error validating YAML", e);
    }
  }

  // M13: apply_attempts_until_success
  const metrics = readMetrics(runId);
  const apply_attempts_until_success = (metrics.apply_attempts_until_success || 0) + 1;

  let blocked_reason = metrics.blocked_reason;
  if (!apply_success && !blocked_reason) {
    blocked_reason = "other:apply_failed_unknown";
  }

  const updatePayload: any = {
    apply_success,
    schema_valid,
    yaml_hash,
    apply_attempts_until_success,
    receipt_path: receiptPath,
  };

  if (blocked_reason) {
    updatePayload.blocked_reason = blocked_reason;
  }

  if (apply_success) {
    // M5 & M6
    const decisionsPath = path.join(docsDir, ".proposals", `${runId}.decisions.json`);
    let accepted_nontrivial_count = 0;
    let accepted_nontrivial_with_anchor_count = 0;
    let resolvable_anchor_count = 0;
    let total_evaluated_anchor_count = 0;

    if (fs.existsSync(decisionsPath)) {
      const decisionsRaw = JSON.parse(fs.readFileSync(decisionsPath, "utf-8"));
      // Decisions file can be a raw array or {decisions: [...]}
      const decisions: any[] = Array.isArray(decisionsRaw)
        ? decisionsRaw
        : decisionsRaw.decisions || [];

      // Build factsMap from BOTH proposal.facts AND confidence_report.
      // proposal.facts only contains gate-rejected rows; accepted facts
      // live in confidence_report.
      const proposalPath = path.join(docsDir, ".proposals", `${runId}.json`);
      let factsMap = new Map();
      if (fs.existsSync(proposalPath)) {
        const proposalData = JSON.parse(fs.readFileSync(proposalPath, "utf-8"));
        for (const fact of proposalData.facts || []) {
          factsMap.set(fact.jsonPath, fact);
        }
        for (const row of proposalData.confidence_report || []) {
          if (!factsMap.has(row.jsonPath)) {
            factsMap.set(row.jsonPath, {
              jsonPath: row.jsonPath,
              source: { kind: row.kind },
              confidence: row.confidence,
              gate: row.gate,
              repoSources: (row.sources || []).map((s: string) => {
                const m = s.match(/^(.+?)#L(\d+)-L(\d+)$/);
                return m
                  ? { path: m[1], startLine: parseInt(m[2], 10), endLine: parseInt(m[3], 10) }
                  : { path: s, startLine: 1, endLine: 1 };
              }),
            });
          }
        }
      }

      for (const decision of decisions) {
        if (decision.decision === "accept" || decision.decision === "edit") {
          const fact = factsMap.get(decision.jsonPath);
          // Anchors can come from the decision itself or from the fact/CR row
          const anchors = decision.anchors || fact?.repoSources || [];
          // For nontrivial check we only need the path; the value doesn't
          // matter beyond confirming the path is not an internal/trivial one.
          if (!isTrivial(decision.jsonPath, "placeholder")) {
            accepted_nontrivial_count++;
            if (anchors.length > 0) {
              accepted_nontrivial_with_anchor_count++;
            }

            for (const anchor of anchors) {
              total_evaluated_anchor_count++;
              if (headSha && checkAnchorResolvability(anchor, headSha)) {
                resolvable_anchor_count++;
              }
            }
          }
        }
      }
    }

    updatePayload.accepted_nontrivial_count = accepted_nontrivial_count;
    updatePayload.accepted_nontrivial_with_anchor_count = accepted_nontrivial_with_anchor_count;
    updatePayload.anchor_compliance_accepted_nontrivial = accepted_nontrivial_count > 0 ? accepted_nontrivial_with_anchor_count / accepted_nontrivial_count : 0;

    updatePayload.resolvable_anchor_count = resolvable_anchor_count;
    updatePayload.total_evaluated_anchor_count = total_evaluated_anchor_count;
    updatePayload.anchor_resolvability_rate_accepted = total_evaluated_anchor_count > 0 ? resolvable_anchor_count / total_evaluated_anchor_count : 0;

    // M7
    let populated_leaf_count = 0;
    let populated_leaf_anchored_count = 0;
    try {
      const yamlContent = fs.readFileSync(yamlPath, "utf-8");
      const parsedYaml = yamlParse(yamlContent) as Record<string, unknown>;
      const leafNodes = getLeafNodes(parsedYaml);

      const anchorsData = JSON.parse(fs.readFileSync(anchorsPath, "utf-8"));
      const anchoredPaths = new Set(
        anchorsData.anchorsByPath
          ? Object.keys(anchorsData.anchorsByPath)
          : Array.isArray(anchorsData)
            ? anchorsData.map((a: any) => a.jsonPath)
            : []
      );

      // Convert anchoredPaths set to a sorted array (longest first) for prefix matching.
      // Anchors are stored at the parent level (e.g. "$.mlCore.features") but
      // leaf nodes live at array-element level (e.g. "$.mlCore.features[0]").
      // An exact match would miss all array/object children, so we use
      // startsWith to count any leaf whose path is *under* an anchored parent.
      const anchoredPathsArray = Array.from(anchoredPaths).sort((a, b) => b.length - a.length);

      for (const node of leafNodes) {
        if (!isTrivial(node.path, node.value)) {
          populated_leaf_count++;
          const isAnchored = anchoredPaths.has(node.path) ||
            anchoredPathsArray.some(ap => node.path.startsWith(ap + ".") || node.path.startsWith(ap + "["));
          if (isAnchored) {
            populated_leaf_anchored_count++;
          }
        }
      }
    } catch (e) {
      console.error("Error computing M7", e);
    }

    updatePayload.populated_leaf_count = populated_leaf_count;
    updatePayload.populated_leaf_anchored_count = populated_leaf_anchored_count;
    updatePayload.anchored_field_coverage_leaf = populated_leaf_count > 0 ? populated_leaf_anchored_count / populated_leaf_count : 0;

    // M14
    if (baseSha && headSha) {
      try {
        const diffStat = execSync(`git diff --numstat ${baseSha} ${headSha} -- docs/ml_system_card.yaml`, { encoding: "utf-8" });
        if (diffStat) {
          const parts = diffStat.trim().split(/\s+/);
          if (parts.length >= 2) {
            const added = parseInt(parts[0], 10);
            const removed = parseInt(parts[1], 10);
            updatePayload.added_lines = added;
            updatePayload.removed_lines = removed;
            updatePayload.msc_diff_lines = added + removed;
          }
        }
      } catch (e) {
        console.error("Error computing M14", e);
      }
    }

    // M15 & M16
    const expectationsPath = path.join(docsDir, ".metrics", `${runId}.expectations.json`);
    if (fs.existsSync(expectationsPath) && receiptData) {
      try {
        const expectations = JSON.parse(fs.readFileSync(expectationsPath, "utf-8"));
        const expected_sections = expectations.expected_sections || [];

        const changed_paths = receiptData.changed_paths || [];
        const touched_sections = new Set<string>();
        for (const p of changed_paths) {
          const match = p.match(/^\$\.([^.\[]+)/);
          if (match) {
            touched_sections.add(match[1]);
          }
        }

        const touchedArray = Array.from(touched_sections);
        const hitCount = expected_sections.filter((s: string) => touched_sections.has(s)).length;

        updatePayload.expected_sections = expected_sections;
        updatePayload.touched_sections = touchedArray;
        updatePayload.expected_section_hit_rate = expected_sections.length > 0 ? hitCount / expected_sections.length : 0;

        const off_target_sections = touchedArray.filter(s => !expected_sections.includes(s));
        updatePayload.off_target_sections = off_target_sections;
        updatePayload.off_target_section_count = off_target_sections.length;

        let off_target_path_count = 0;
        for (const p of changed_paths) {
          const match = p.match(/^\$\.([^.\[]+)/);
          if (match && !expected_sections.includes(match[1])) {
            off_target_path_count++;
          }
        }
        updatePayload.off_target_path_count = off_target_path_count;

      } catch (e) {
        console.error("Error computing M15/M16", e);
      }
    }
  }

  writeMetrics(runId, updatePayload);
}
