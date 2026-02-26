#!/usr/bin/env node
import { diffNameOnly, diffShortStat, readFileAtCommit } from "../utils/git.js";
import { logger } from "../utils/logger.js";
import { validateCardArtifacts } from "../validate_card.js";
import { inspectCardDiff } from "../analysis/diff_inspector.js";
import {
  ALLOWED_PATH_PREFIXES,
  CARD_PATH,
  MAX_CARD_GROWTH_RATIO,
  MAX_DIFF_LINES
} from "../constants.js";

interface CiArgs {
  baseRef: string;
  headRef: string;
  diffLimit?: number;
}

async function main(): Promise<void> {
  const args = parseArgs();
  logger.info("Running ML System Card CI", { base: args.baseRef, head: args.headRef });

  await enforcePathAllowList(args);
  await enforceDiffSafety(args);
  await enforceSemanticIntegrity(args);
  const validation = await validateCardArtifacts();

  if (validation.errors.length > 0) {
    logger.error("Validation errors", { errors: validation.errors });
    throw new Error("ML System Card validation failed");
  }

  // Ensure no pending proposals are left in the PR.
  // If proposals exist, it means the user hasn't run "Apply" yet.
  // We must fail the build to prevent manual merging of stale state.
  await enforceNoPendingProposals();

  logger.info("ML System Card CI checks passed", {
    coverage: validation.coverage,
    schemaValid: validation.schemaValid,
    anchorsSchemaValid: validation.anchorsSchemaValid
  });
}

async function enforceNoPendingProposals(): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { PROPOSALS_DIR } = await import("../constants.js");

  try {
    const files = await readdir(PROPOSALS_DIR);
    const proposalFiles = files.filter(f => f.endsWith(".json") && !f.startsWith("."));

    if (proposalFiles.length > 0) {
      throw new Error(
        `Pending proposals detected in ${PROPOSALS_DIR}. You must use the "Apply" workflow (via the Review Dashboard) to merge these changes into ml_system_card.yaml before this PR can be merged.`
      );
    }
  } catch (error) {
    // If directory doesn't exist, that's fine (no proposals).
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function enforcePathAllowList(args: CiArgs): Promise<void> {
  const changed = await diffNameOnly(args.baseRef, args.headRef);
  const prohibited = changed.filter((path) => !ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)));
  if (prohibited.length > 0) {
    throw new Error(`Changes outside allow-list detected: ${prohibited.join(", ")}`);
  }
  if (args.diffLimit && changed.length > args.diffLimit) {
    throw new Error(`Diff too large: ${changed.length} files changed (limit ${args.diffLimit})`);
  }
}

async function enforceDiffSafety(args: CiArgs): Promise<void> {
  const baseCard = await readFileAtCommit(CARD_PATH, args.baseRef);

  // On first runs (no baseline card) the diff is expected to be large
  // because the entire card is created from scratch. Skip the line limit.
  if (!baseCard) {
    logger.info("First run detected — skipping diff line-count limit");
    return;
  }

  const stats = await diffShortStat(args.baseRef, args.headRef);
  const totalLines = stats.insertions + stats.deletions;
  const lineLimit = MAX_DIFF_LINES;
  if (totalLines > lineLimit) {
    throw new Error(`Diff too large: ${totalLines} changed lines (limit ${lineLimit})`);
  }

  const headCard = await readFileAtCommit(CARD_PATH, args.headRef);
  if (!headCard) {
    return;
  }

  const baseSize = baseCard.length;
  if (baseSize === 0) {
    return;
  }

  const growth = headCard.length - baseCard.length;
  if (growth <= 0) {
    return;
  }

  const growthRatio = growth / baseSize;
  if (growthRatio > MAX_CARD_GROWTH_RATIO) {
    const pct = (growthRatio * 100).toFixed(1);
    throw new Error(`Card size growth too large: +${pct}% (limit ${(MAX_CARD_GROWTH_RATIO * 100).toFixed(0)}%)`);
  }
}

async function enforceSemanticIntegrity(args: CiArgs): Promise<void> {
  const baseCard = await readFileAtCommit(CARD_PATH, args.baseRef);
  const headCard = await readFileAtCommit(CARD_PATH, args.headRef);

  if (!baseCard || !headCard) {
    return;
  }

  const report = inspectCardDiff(baseCard, headCard);

  if (report.isNoiseOnly) {
    throw new Error(
      "Formatting-only change detected (Noise). The YAML content is semantically identical but the file text has changed. Please run 'npm run format' or revert the file to match the canonical deterministic output."
    );
  }

  if (report.hasSemanticChanges) {
    logger.info("Semantic changes detected", {
      count: report.semanticChanges.length,
      ops: report.semanticChanges.slice(0, 5).map((op) => `${op.op} ${op.path}`)
    });
  } else {
    logger.info("No semantic changes detected");
  }
}

function parseArgs(): CiArgs {
  const argv = process.argv.slice(2);
  const args: Partial<CiArgs> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--base-ref") {
      args.baseRef = argv[++i];
    } else if (token === "--head-ref") {
      args.headRef = argv[++i];
    } else if (token === "--diff-limit") {
      args.diffLimit = Number.parseInt(argv[++i], 10);
    }
  }
  if (!args.baseRef || !args.headRef) {
    throw new Error("Usage: ci --base-ref <sha> --head-ref <sha> [--diff-limit <n>]");
  }
  return args as CiArgs;
}

void main().catch((error) => {
  logger.error("CI checks failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
