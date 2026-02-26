#!/usr/bin/env node
import { join } from "node:path";

import type { Proposal } from "lib/card/types.js";

import { PROPOSALS_DIR } from "../constants.js";
import { readTextFile } from "../utils/fs.js";
import { logger } from "../utils/logger.js";

async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId) {
    throw new Error("Usage: post-summary <runId>");
  }

  const path = join(PROPOSALS_DIR, `${runId}.json`);
  const raw = await readTextFile(path);
  if (!raw) {
    logger.warn("No proposal found for summary", { path });
    return;
  }

  const proposal = JSON.parse(raw) as Proposal;
  const okCount = proposal.facts.filter((fact) => fact.gate === "OK").length;
  const warnCount = proposal.facts.filter((fact) => fact.gate === "Warn").length;
  const requireCount = proposal.facts.filter((fact) => fact.gate === "Require").length;

  const summary = `Run ${proposal.meta.runId}: coverage=${proposal.diagnostics.coverage_non_null.toFixed(2)} facts=${proposal.facts.length} (OK=${okCount}, Warn=${warnCount}, Require=${requireCount})`;
  logger.info(summary);

  if (proposal.meta.telemetry) {
    const { latencyMs, tokens, retries } = proposal.meta.telemetry;
    logger.info("Telemetry", {
      latency: `${(latencyMs / 1000).toFixed(2)}s`,
      tokens: `${tokens.total} (P:${tokens.prompt} + C:${tokens.completion})`,
      retries
    });
  }

  if (proposal.meta.provenance) {
    logger.info("Provenance", {
      model: proposal.meta.provenance.model,
      promptId: proposal.meta.provenance.promptId
    });
  }
}

void main().catch((error) => {
  logger.error("Failed to post summary", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
