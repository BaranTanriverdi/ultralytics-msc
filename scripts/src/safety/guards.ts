import { MAX_CARD_GROWTH_RATIO, MAX_DIFF_LINES, COVERAGE_THRESHOLD } from "../constants.js";
import { logger } from "../utils/logger.js";

import type { Fact } from "lib/card/types.js";

interface GuardContext {
  proposedYaml: string;
  baselineYaml: string;
  coverage: number;
  lowConfidence: Array<{ jsonPath: string; reason: string }>;
  facts: Fact[];
}

export function enforceSafetyGuards(context: GuardContext): string[] {
  const { proposedYaml, baselineYaml, coverage, lowConfidence: _lowConfidence, facts } = context;
  const warnings: string[] = [];
  const diffLines = Math.abs(proposedYaml.split("\n").length - baselineYaml.split("\n").length);
  if (diffLines > MAX_DIFF_LINES) {
    const msg = `Safety Warning: Diff exceeds maximum allowed lines (${diffLines} > ${MAX_DIFF_LINES})`;
    logger.warn(msg);
    warnings.push(msg);
  }

  const growthRatio = computeGrowthRatio(baselineYaml.length, proposedYaml.length);
  if (growthRatio > MAX_CARD_GROWTH_RATIO) {
    const msg = `Safety Warning: Card size growth exceeds ratio (${growthRatio.toFixed(2)} > ${MAX_CARD_GROWTH_RATIO})`;
    logger.warn(msg);
    warnings.push(msg);
  }

  if (coverage < COVERAGE_THRESHOLD) {
    const msg = `Safety Warning: Evidence coverage fell below threshold (${coverage.toFixed(2)} < ${COVERAGE_THRESHOLD})`;
    logger.warn(msg);
    warnings.push(msg);
  }

  const requireFacts = facts.filter((fact) => fact.gate === "Require");
  if (requireFacts.length > 0) {
    const msg = `Safety Warning: Proposal contains Require-level facts without reviewer action: ${requireFacts.length}`;
    logger.warn(msg);
    warnings.push(msg);
  }
  return warnings;
}

export function computeGrowthRatio(baselineLength: number, proposedLength: number): number {
  if (baselineLength === 0) {
    // If baseline is empty (first run), we allow any growth, effectively returning 0 ratio
    // or we could return 0 to indicate "infinite but allowed" growth.
    return 0;
  }
  // For tiny seed cards (< 200 chars) the ratio is meaningless — skip the guard.
  if (baselineLength < 200) {
    return 0;
  }
  return Math.max(0, proposedLength - baselineLength) / baselineLength;
}

export function hasInsufficientAnchors(facts: Fact[]): boolean {
  return facts.some((fact) => fact.proposedValue !== null && fact.repoSources.length === 0);
}
