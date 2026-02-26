#!/usr/bin/env node
import { join } from "node:path";

import { load } from "js-yaml";
import { createPatch } from "rfc6902";

import type { Proposal, Fact, ConfidenceReportRow, Anchor } from "lib/card/types.js";

import { PROPOSALS_DIR } from "../constants.js";
import { createEmptyCard, type CardSeed } from "../card/seed.js";
import { computeIncrementalFileSet } from "../incremental_set.js";
import { readTextFile, writeTextFile } from "../utils/fs.js";
import { logger } from "../utils/logger.js";
import fsExtra from "fs-extra";
import { validateProposal } from "../contracts/validators.js";
import { buildAnalysisBundle } from "../analysis/bundle.js";
import { resolveLlmRuntimeConfig } from "../config/env.js";
import { runExtractorPass } from "../llm/extractor.js";
import { runReasonerPass } from "../llm/reasoner.js";
import { runVerifierPass } from "../llm/verifier.js";
import { runNotesPass } from "../llm/notes.js";
import { stringifyDeterministic } from "../card/deterministic.js";
import { enforceSafetyGuards, hasInsufficientAnchors } from "../safety/guards.js";
import { redactSecrets, isMscInfrastructure } from "../safety/redaction.js";

interface GeneratorArgs {
  runId: string;
  baseSha: string;
  schemaVersion: string;
}

async function pruneExistingProposals(dir: string): Promise<void> {
  if (!await fsExtra.pathExists(dir)) {
    return;
  }

  const files = await fsExtra.readdir(dir);
  let deletedCount = 0;

  for (const file of files) {
    if (file.endsWith(".json")) {
      await fsExtra.remove(join(dir, file));
      deletedCount++;
    }
  }

  if (deletedCount > 0) {
    logger.info("Pruned existing proposals", { count: deletedCount, dir });
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  logger.info("Starting generator", { runId: args.runId, baseSha: args.baseSha });

  await pruneExistingProposals(PROPOSALS_DIR);

  const existingCardContent = await readTextFile("docs/ml_system_card.yaml");
  const baselineCard = parseCard(existingCardContent);

  // If the card exists but is effectively empty (just a seed), we treat it as a first run
  // to ensure we scan the entire codebase.
  const isSeed = !baselineCard.business?.executiveSummary && !baselineCard.mlCore?.problem;
  const isFirstRun = !existingCardContent || isSeed;

  let changedFiles: string[];
  if (isFirstRun) {
    logger.info(
      isSeed
        ? "Seed card detected. Performing full scan."
        : "First run detected (no ml_system_card.yaml). Performing full scan."
    );
    // For first run, we want a comprehensive scan, but we must be mindful of limits.
    // We'll use the incremental set's critical patterns + all source files,
    // but we might need to rely on the bundle builder to truncate if it's too huge.
    // For now, let's gather all non-ignored files.
    const { lsFiles } = await import("../utils/git.js");
    const allFiles = await lsFiles(["."]);
    changedFiles = allFiles.filter((f) => !isMscInfrastructure(f));
    logger.info("Full scan selected files", { total: allFiles.length, afterMscFilter: changedFiles.length });
  } else {
    const headSha = process.env.GITHUB_SHA ?? (await readGitHead());
    const incremental = await computeIncrementalFileSet(args.baseSha, headSha);
    changedFiles = incremental.changed.filter((f) => !isMscInfrastructure(f));
    logger.info("Computed incremental file set", { changed: incremental.changed.length, afterMscFilter: changedFiles.length });
  }

  await ensureProposalDirectory();
  const runtimeConfig = resolveLlmRuntimeConfig();
  const analysis = await buildAnalysisBundle({
    runId: args.runId,
    baseSha: args.baseSha,
    headSha: process.env.GITHUB_SHA ?? "HEAD", // Fallback for first run
    changedFiles
  });

  const extractorResult = await runExtractorPass({
    runId: args.runId,
    baselineCard,
    analysis,
    runtime: runtimeConfig
  });

  const reasonerResult = await runReasonerPass(
    {
      runId: args.runId,
      baselineCard,
      analysis,
      runtime: runtimeConfig
    },
    extractorResult
  );

  const verifierResult = await runVerifierPass(
    {
      runId: args.runId,
      baselineCard,
      analysis,
      runtime: runtimeConfig
    },
    reasonerResult
  );

  const notesResult = await runNotesPass(
    {
      runId: args.runId,
      baselineCard,
      analysis,
      runtime: runtimeConfig
    },
    verifierResult
  );

  const { mutatedCard, facts, coverageNonNull, lowConfidence } = reasonerResult;
  // Use verified facts for the final proposal, but keep reasoner's mutated card structure for now
  // Actually, verifier might have changed gates/confidence, so we should use verifierResult.facts
  const finalFacts = verifierResult.facts;

  // Re-apply facts to card to ensure consistency with verifier changes (though verifier only changes metadata, not values)
  // But let's be safe.
  // Wait, reasonerResult.mutatedCard is based on reasonerResult.facts.
  // If verifier changed gates, it doesn't affect the card content (YAML), only the proposal metadata.
  // So using reasonerResult.mutatedCard is fine for the YAML patch.

  // CRM-1: Inject latest stakeholder notes into the card content (YAML)
  if (notesResult.notes && Object.keys(notesResult.notes).length > 0) {
    // Cast to any because mutatedCard type might not strictly imply specific schema fields here
    (mutatedCard as any).stakeholderNotes = notesResult.notes;
  }

  const patch = createPatch(baselineCard, mutatedCard);
  const confidenceReport = buildConfidenceReport(finalFacts);
  const sources = deriveProposalSources(confidenceReport);

  if (hasInsufficientAnchors(finalFacts)) {
    throw new Error("At least one proposed fact lacks anchors; aborting proposal generation.");
  }

  const totalLatency = extractorResult.metrics.latencyMs + reasonerResult.metrics.latencyMs + verifierResult.metrics.latencyMs + notesResult.metrics.latencyMs;
  const totalPromptTokens = extractorResult.metrics.promptTokens + reasonerResult.metrics.promptTokens + verifierResult.metrics.promptTokens + notesResult.metrics.promptTokens;
  const totalCompletionTokens = extractorResult.metrics.completionTokens + reasonerResult.metrics.completionTokens + verifierResult.metrics.completionTokens + notesResult.metrics.completionTokens;
  const totalRetries = Math.max(0, extractorResult.attempts - 1) + Math.max(0, reasonerResult.attempts - 1) + Math.max(0, verifierResult.attempts - 1) + Math.max(0, notesResult.attempts - 1);

  // If existingCardContent is null (first run), baselineYaml should be empty string to trigger the "0 growth ratio" logic
  const baselineYaml = existingCardContent ?? "";
  const proposedYaml = stringifyDeterministic(mutatedCard);

  const warnings = enforceSafetyGuards({
    baselineYaml,
    proposedYaml,
    coverage: coverageNonNull,
    lowConfidence,
    facts
  });

  const proposal: Proposal = {
    meta: {
      runId: args.runId,
      baseSha: args.baseSha,
      schemaVersion: args.schemaVersion,
      thresholds: { ok: 0.8, warn: 0.65 },
      provenance: {
        promptId: reasonerResult.promptId, // Primary logic prompt
        model: reasonerResult.llm?.model ?? null,
        generatedAt: new Date().toISOString()
      },
      telemetry: {
        latencyMs: totalLatency,
        tokens: {
          prompt: totalPromptTokens,
          completion: totalCompletionTokens,
          total: totalPromptTokens + totalCompletionTokens
        },
        retries: totalRetries
      },
      passTelemetry: {
        extractor: { ...extractorResult.metrics },
        reasoner:  { ...reasonerResult.metrics },
        verifier:  { ...verifierResult.metrics },
        notes:     { ...notesResult.metrics }
      }
    },
    facts: finalFacts,
    patch,
    card_patch: patch,
    notes: notesResult.notes,
    diagnostics: {
      coverage_non_null: coverageNonNull,
      low_confidence: lowConfidence,
      warnings
    },
    confidence_report: confidenceReport,
    sources
  };

  const proposalPath = join(PROPOSALS_DIR, `${args.runId}.json`);
  const proposalJson = JSON.stringify(proposal, null, 2);
  const sanitized = redactSecrets(proposalJson);

  const validationErrors = await validateProposal(proposal);
  if (validationErrors.length > 0) {
    throw new Error(`Proposal schema validation failed: ${validationErrors.join("; ")}`);
  }

  await writeTextFile(proposalPath, sanitized.content);

  logger.info("Proposal written", {
    path: proposalPath,
    facts: facts.length,
    patch: patch.length,
    redactions: sanitized.redactions
  });
}

function parseArgs(): GeneratorArgs {
  const argv = process.argv.slice(2);
  const args: Partial<GeneratorArgs> = { schemaVersion: "1.0.0" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--run-id") {
      args.runId = argv[++i];
    } else if (token === "--base-sha") {
      args.baseSha = argv[++i];
    } else if (token === "--schema-version") {
      args.schemaVersion = argv[++i];
    }
  }
  if (!args.runId || !args.baseSha || !args.schemaVersion) {
    throw new Error("Usage: generator --run-id <id> --base-sha <sha> [--schema-version <ver>]");
  }
  return args as GeneratorArgs;
}

function buildConfidenceReport(facts: Fact[]): ConfidenceReportRow[] {
  return facts
    .map((fact) => ({
      jsonPath: fact.jsonPath,
      kind: fact.source.kind,
      confidence: fact.confidence,
      gate: fact.gate,
      sources: fact.repoSources.map(anchorToDeepLink)
    }))
    .sort((a, b) => a.jsonPath.localeCompare(b.jsonPath));
}

function deriveProposalSources(confidenceReport: ConfidenceReportRow[]): string[] {
  const unique = new Set<string>();
  confidenceReport.forEach((row) => {
    row.sources.forEach((source) => {
      if (source) {
        unique.add(source);
      }
    });
  });
  return Array.from(unique).sort((a, b) => a.localeCompare(b));
}

function parseCard(yaml: string | null): CardSeed {
  if (!yaml) {
    return createEmptyCard();
  }
  const parsed = load(yaml) as CardSeed | null;
  if (!parsed || typeof parsed !== "object") {
    return createEmptyCard();
  }
  return parsed;
}

async function ensureProposalDirectory(): Promise<void> {
  await fsExtra.ensureDir(PROPOSALS_DIR);
}

async function readGitHead(): Promise<string> {
  const content = await readTextFile(".git/HEAD");
  if (!content) {
    throw new Error("Unable to resolve git HEAD");
  }
  const refMatch = content.trim().match(/^ref: (.+)$/);
  if (!refMatch) {
    return content.trim();
  }
  const refPath = refMatch[1];
  const refContent = await readTextFile(join(".git", refPath));
  if (!refContent) {
    throw new Error(`Unable to resolve ref ${refPath}`);
  }
  return refContent.trim();
}

function anchorToDeepLink(anchor: Anchor): string {
  const suffix = anchor.startLine === anchor.endLine
    ? `#L${anchor.startLine}`
    : `#L${anchor.startLine}-L${anchor.endLine}`;
  return `${anchor.path}${suffix}`;
}
void main().catch((error) => {
  logger.error("Generator failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
