import * as fs from "fs";
import * as path from "path";
import { writeMetrics, readMetrics } from "../storage.js";

export async function runDecisionsStage(runId: string) {
  const decisionsPath = path.join(process.cwd(), "docs", ".proposals", `${runId}.decisions.json`);

  if (!fs.existsSync(decisionsPath)) {
    console.warn(`Decisions file not found: ${decisionsPath}`);
    return;
  }

  const decisionsData = JSON.parse(fs.readFileSync(decisionsPath, "utf-8"));
  const decisions = Array.isArray(decisionsData) ? decisionsData : decisionsData.decisions || [];

  let decision_accepted_count = 0;
  let decision_edited_count = 0;
  let decision_rejected_count = 0;

  for (const decision of decisions) {
    if (decision.decision === "accept") decision_accepted_count++;
    else if (decision.decision === "edit") decision_edited_count++;
    else if (decision.decision === "reject") decision_rejected_count++;
  }

  const metrics = readMetrics(runId);
  const facts_total = metrics.facts_total || 0;

  const decided_count = decision_accepted_count + decision_edited_count + decision_rejected_count;
  const decision_undecided_count = Math.max(0, facts_total - decided_count);

  const decision_accepted_pct = facts_total > 0 ? decision_accepted_count / facts_total : 0;
  const decision_edited_pct = facts_total > 0 ? decision_edited_count / facts_total : 0;
  const decision_rejected_pct = facts_total > 0 ? decision_rejected_count / facts_total : 0;
  const decision_undecided_pct = facts_total > 0 ? decision_undecided_count / facts_total : 0;

  writeMetrics(runId, {
    decision_accepted_count,
    decision_edited_count,
    decision_rejected_count,
    decision_undecided_count,
    decision_accepted_pct,
    decision_edited_pct,
    decision_rejected_pct,
    decision_undecided_pct,
    decisions_path: decisionsPath,
  });
}
