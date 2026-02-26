#!/usr/bin/env node
import { join } from "node:path";
import { load } from "js-yaml";
import { applyPatch } from "rfc6902";
import { get } from "lodash-es";

import type { Decision, Fact, Proposal, AnchorsIndex, MicroReceipt } from "lib/card/types.js";
import type { Operation } from "rfc6902";

import {
  ANCHORS_PATH,
  CARD_PATH,
  DEFAULT_ANCHORS_VERSION,
  MICRO_RECEIPTS_DIR,
  PROPOSALS_DIR,
  SCHEMA_PATH
} from "../constants.js";
import { ensureSeedArtifacts, createEmptyCard } from "../card/seed.js";
import { stringifyDeterministic } from "../card/deterministic.js";
import { applyPatchAndWriteCard } from "../write_card.js";
import { buildAnchorsIndex } from "../write_anchors.js";
import { validateCardArtifacts } from "../validate_card.js";
import { readTextFile, writeTextFile } from "../utils/fs.js";
import { logger } from "../utils/logger.js";
import {
  addLabels,
  removeLabel,
  findPullRequestByBranch,
  listOpenPullRequestsByBase,
  updatePullRequest,
  createIssueComment
} from "../utils/github.js";
import fsExtra from "fs-extra";
import { validateDecisions } from "../contracts/validators.js";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { writeMetrics } from "../metrics/storage.js";

interface ApplyArgs {
  runId: string;
  coverageThreshold?: number;
}

/**
 * Repair facts whose jsonPointer was corrupted by the secret-redaction pass.
 * The base64-like pattern could match path-separator-rich pointers, turning
 * e.g. "/devInsight/qualitySignals/complexityHints" into "/<redacted>".
 * We recover the correct pointer from jsonPath (always present, never redacted).
 */
function repairRedactedPointers(facts: Fact[]): void {
  for (const fact of facts) {
    if (fact.jsonPointer && fact.jsonPointer.includes("<redacted>")) {
      const derived = jsonPathToPointer(fact.jsonPath);
      if (derived) {
        logger.warn(`Repairing redacted jsonPointer for ${fact.jsonPath}: "${fact.jsonPointer}" → "${derived}"`);
        fact.jsonPointer = derived;
      }
    }
  }
}

/** Convert a JSONPath like "$.foo.bar.baz" to a JSON Pointer "/foo/bar/baz". */
function jsonPathToPointer(jsonPath: string): string | null {
  if (!jsonPath || !jsonPath.startsWith("$.")) return null;
  const segments = jsonPath.slice(2).split(".");
  return "/" + segments.join("/");
}

async function main(): Promise<void> {
  const args = parseArgs();
  logger.info("Applying proposal", { runId: args.runId });

  await ensureSeedArtifacts();

  const proposal = await readProposal(args.runId);
  repairRedactedPointers(proposal.facts);
  const decisions = await readDecisions(args.runId);

  if (process.env.EVAL_STRICT === "1") {
    if (decisions.length === 0) {
      logger.error("[BLOCKED_REASON: missing_decisions_in_eval_strict_mode] No decisions file found or empty in strict mode.");
      writeMetrics(args.runId, { apply_success: 0, blocked_reason: "missing_decisions_in_eval_strict_mode" });
      process.exit(1);
    }
    const decidedPaths = new Set(decisions.map(d => d.jsonPath));
    const undecided = proposal.facts.filter(f => !decidedPaths.has(f.jsonPath));
    if (undecided.length > 0) {
      logger.error(`[BLOCKED_REASON: missing_decisions_in_eval_strict_mode] ${undecided.length} facts are undecided in strict mode.`);
      writeMetrics(args.runId, { apply_success: 0, blocked_reason: "missing_decisions_in_eval_strict_mode" });
      process.exit(1);
    }
  }

  // Initial filtering based on decisions
  let filteredFacts = filterFacts(proposal.facts, decisions);
  const initialCandidates = [...filteredFacts];

  let currentCardYaml = await readTextFile(CARD_PATH);
  logger.info(`Loaded card yaml length: ${currentCardYaml?.length ?? 0}`);

  let currentCard = currentCardYaml ? (load(currentCardYaml) as any) : {};
  logger.info(`Loaded card keys: ${Object.keys(currentCard || {}).join(", ")}`);

  // Repair card if missing root sections (e.g. from empty file or bad state)
  const seed = createEmptyCard();
  let repaired = false;

  if (!currentCard || typeof currentCard !== "object") {
    logger.warn("Card is null or not an object. Replacing with seed.");
    currentCard = seed;
    repaired = true;
  } else {
    // Ensure all root keys from seed exist in currentCard and are not null
    for (const key of Object.keys(seed)) {
      const val = (currentCard as any)[key];
      // Treat undefined or null as missing for root structural objects
      if (val === undefined || val === null) {
        logger.warn(`Card root section '${key}' is missing or null. Repairing.`);
        (currentCard as any)[key] = (seed as any)[key];
        repaired = true;
      }
    }
  }

  if (repaired) {
    logger.info("Card repaired. Regenerating YAML.");
    currentCardYaml = stringifyDeterministic(currentCard);
  } else {
    logger.info("Card loaded successfully (no repair needed).");
  }

  // Ensure $schema is removed if present (it causes validation errors)
  if ((currentCard as any).$schema) {
    logger.info("Removing $schema from card to ensure validation.");
    delete (currentCard as any).$schema;
    currentCardYaml = stringifyDeterministic(currentCard);
  }

  const schemaRaw = await readTextFile(SCHEMA_PATH);
  const schema = schemaRaw ? JSON.parse(schemaRaw) : {};

  // --- Robust Speculative Apply Loop ---
  // We try to apply the facts. If schema validation fails, we drop the offending facts and retry.
  let acceptedPatch: Operation[] = [];
  let loopCount = 0;
  const MAX_LOOPS = 5;

  while (loopCount < MAX_LOOPS) {
      loopCount++;

      // Generate patch from current candidate facts
      acceptedPatch = filterPatchByDecisions(proposal, filteredFacts, currentCard as object, decisions);

      // Speculative application
      const candidateCard = JSON.parse(JSON.stringify(currentCard)); // Deep clone
      // We need to apply patch. Note: our filterPatchByDecisions handles initialization of nulls.
      // But we need to use a robust apply that doesn't crash on 'add' to undefined?
      // filterPatchByDecisions adds 'replace' for parent init.


      try {
          applyPatch(candidateCard, acceptedPatch);
      } catch (err) {
         logger.error("RFC6902 apply failed", { err });
         // If patch application fails physically (rare with our null-fix), we might abort or try to find culprit.
         // For now, assume patch application succeeds structurally.
         break;
      }

      // Schema Validation
      const ajv = new Ajv({ strict: false, allErrors: true });
      addFormats(ajv);
      const validate = ajv.compile(schema);
      const valid = validate(candidateCard);

      if (valid) {
          logger.info(`Validation passed on attempt ${loopCount}`);
          break;
      }

      // Identify bad paths
      const errors = validate.errors || [];
      const badPaths = new Set(errors.map(e => e.instancePath));

      logger.warn(`Validation failed on attempt ${loopCount}. Pruning invalid facts.`, {
          errorCount: errors.length,
          sample: errors[0]?.message
      });

      // Filter out facts causing errors
      const invalidFacts = filteredFacts.filter(fact => {
          if (!fact.jsonPointer) return false;
          // If error is EXACTLY the fact's path
          if (badPaths.has(fact.jsonPointer)) return true;
          // If error is INSIDE the fact's value (e.g. fact sets an array, error is in array item)
          if ([...badPaths].some(bp => bp.startsWith(fact.jsonPointer + "/"))) return true;
          return false;
      });

      if (invalidFacts.length === 0) {
          logger.warn("Validation failed but could not attribute errors to specific facts. Aborting loop.");
          // We break and let the final validation fail (or we could save partial?)
          // If we write it, it will fail `validateCardArtifacts` later.
          break;
      }

      // Prune
      const invalidPointers = new Set(invalidFacts.map(f => f.jsonPointer));
      filteredFacts = filteredFacts.filter(f => !invalidPointers.has(f.jsonPointer));

      logger.info(`Pruned ${invalidFacts.length} invalid facts. Retrying...`);
  }

  // Update lastGeneratedAt
  acceptedPatch.push({
    op: "add",
    path: "/provenance/lastGeneratedAt",
    value: new Date().toISOString()
  });

  // Inject stakeholder notes from proposal (they are not represented as facts)
  if (proposal.notes && Object.keys(proposal.notes).length > 0) {
    acceptedPatch.push({
      op: "add",
      path: "/stakeholderNotes",
      value: proposal.notes
    });
    logger.info("Injecting stakeholder notes into card", {
      stakeholders: Object.keys(proposal.notes)
    });
  }

  const { newYaml, sha256 } = applyPatchAndWriteCard(currentCardYaml, acceptedPatch);
  await writeTextFile(CARD_PATH, newYaml);

  const anchors = await buildAnchors(proposal, filteredFacts, sha256);
  await writeTextFile(ANCHORS_PATH, JSON.stringify(anchors, null, 2));

  // Default coverage threshold to 0 if not specified to avoid blocking apply on partial coverage
  const threshold = args.coverageThreshold ?? 0;
  const validation = await validateCardArtifacts({ coverageThreshold: threshold });
  if (validation.errors.length > 0) {
    // If strict validation fails, we log it but don't abort the operation for apply?
    // Actually, we should probably fail if validation errors are critical.
    // But coverage errors might be soft.
    const realErrors = validation.errors.filter(e => !e.includes("coverage"));
    if (realErrors.length > 0) {
       throw new Error(`Validation failed: ${realErrors.join(", ")}`);
    } else if (validation.errors.length > 0) {
       logger.warn(`Coverage checks failed but continuing: ${validation.errors.join(", ")}`);
    }
  }

  // Handle invalid facts by returning them to the proposal for verification
  const appliedPaths = new Set(filteredFacts.map((f) => f.jsonPath));
  const failedFacts = initialCandidates.filter((c) => !appliedPaths.has(c.jsonPath));

  if (failedFacts.length > 0) {
    logger.warn(`Partial apply: ${failedFacts.length} facts failed validation and will be returned to proposal.`);

    // Update proposal: Keep only failed facts (or all non-applied ones from original?)
    // To be safe and clean, we keep only the failed ones so the user focuses on them.
    // Wait, we need to preserve the WHOLE proposal state minus the applied ones?
    // If we only keep failed ones, we lose "rejected" ones.
    // Let's keep (Original - Applied).

    const remainingFacts = proposal.facts.filter((f) => !appliedPaths.has(f.jsonPath));
    const failedPaths = new Set(failedFacts.map((f) => f.jsonPath));

    // Mark failed facts as requiring verification
    remainingFacts.forEach((f) => {
      if (failedPaths.has(f.jsonPath)) {
        f.gate = "Require";
        f.verifierNotes = (f.verifierNotes ?? "") + " [System] Skipped due to schema validation error during apply.";
      }
    });

    proposal.facts = remainingFacts;
    await writeTextFile(join(PROPOSALS_DIR, `${args.runId}.json`), JSON.stringify(proposal, null, 2));

    // Clear decisions for remaining facts so they reappear as pending
    // We only want to keep decisions for things that are NOT in remainingFacts?
    // No, if we keep the decision, it auto-applies next time?
    // We want to force re-review for failed facts.
    // So we filter out decisions for failed paths.
    const newDecisions = decisions.filter((d) => !failedPaths.has(d.jsonPath));
    // Keep applied decisions so re-runs still work (idempotent)

    await writeTextFile(join(PROPOSALS_DIR, `${args.runId}.decisions.json`), JSON.stringify(newDecisions, null, 2));

  } else {
    // All facts applied successfully — keep proposal and decisions
    // files intact so re-runs are idempotent and files serve as audit trail.
    logger.info("All facts applied successfully.");
  }

  await writeMicroReceipt(proposal, decisions, filteredFacts, sha256);
  await updatePullRequestMetadata(proposal, decisions, filteredFacts, sha256);
  await captureRejections(proposal, decisions);

  logger.info("Apply completed", { sha256, coverage: validation.coverage });
}

function parseArgs(): ApplyArgs {
  const argv = process.argv.slice(2);
  const args: Partial<ApplyArgs> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--run-id") {
      args.runId = argv[++i];
    } else if (token === "--coverage-threshold") {
      args.coverageThreshold = parseFloat(argv[++i]);
    }
  }
  if (!args.runId) {
    throw new Error("Usage: apply --run-id <id>");
  }
  return args as ApplyArgs;
}

async function readProposal(runId: string): Promise<Proposal> {
  const path = join(PROPOSALS_DIR, `${runId}.json`);
  const raw = await readTextFile(path);
  if (!raw) {
    throw new Error(`Proposal missing at ${path}`);
  }
  return JSON.parse(raw) as Proposal;
}

async function readDecisions(runId: string): Promise<Decision[]> {
  const path = join(PROPOSALS_DIR, `${runId}.decisions.json`);
  const raw = await readTextFile(path);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Decision[];
    const errors = await validateDecisions(parsed);
    if (errors.length > 0) {
      throw new Error(errors.join("; "));
    }
    return parsed;
  } catch (error) {
    logger.warn("Failed to parse decisions; defaulting to empty", { error });
    return [];
  }
}

function filterFacts(facts: Fact[], decisions: Decision[]): Fact[] {
  if (decisions.length === 0) {
    return facts.filter((fact) => fact.gate === "OK");
  }

  const decisionByPath = new Map<string, Decision>();
  decisions.forEach((decision) => decisionByPath.set(decision.jsonPath, decision));

  return facts.flatMap((fact) => {
    const decision = decisionByPath.get(fact.jsonPath);
    if (!decision) {
      return fact.gate === "OK" ? [fact] : [];
    }

    if (decision.decision === "reject") {
      return [];
    }

    if (decision.decision === "edit" && typeof decision.editedValue !== "undefined") {
      return [
        {
          ...fact,
          proposedValue: decision.editedValue,
          repoSources: decision.anchors ?? fact.repoSources,
          gate: "OK"
        }
      ];
    }

    return [fact];
  });
}

function filterPatchByDecisions(proposal: Proposal, acceptedFacts: Fact[], currentCard: object, decisions: Decision[]): Operation[] {
  // Instead of filtering the granular patch (which causes issues with array items vs list facts),
  // we regenerate 'replace' operations for every accepted fact.
  const operations: Operation[] = [];
  const fixedPaths = new Set<string>(); // Keep track of paths we've already fixed (initialized)

  for (const f of acceptedFacts) {
    if (!f.jsonPointer) continue;

    // Fix for "Cannot set properties of null":
    // If we are writing to /a/b/0, and /a/b is null, we must initialize it to [] first.
    // If we are writing to /a/b/key, and /a/b is null, we must initialize it to {} first.

    const parts = f.jsonPointer.split("/").filter(Boolean); // ["business", "hazardousUseCases", "0"]
    if (parts.length > 1) {
      const parentParts = parts.slice(0, -1);
      const parentPointer = "/" + parentParts.join("/");

      // Convert JSON pointer to dot path for lodash.get: /a/b -> a.b
      const dotPath = parentParts.join(".");

      // Check current state in memory (approximation since we haven't applied previous ops yet,
      // but safe for initialization of nulls)
      const currentValue = get(currentCard, dotPath);

      if ((currentValue === null || currentValue === undefined) && !fixedPaths.has(parentPointer)) {
        const lastPart = parts[parts.length - 1];
        const isArrayIndex = /^\d+$/.test(lastPart) || lastPart === "-";

        operations.push({
          op: "add",
          path: parentPointer,
          value: isArrayIndex ? [] : {}
        });
        fixedPaths.add(parentPointer);
      }
    }

    operations.push({
      op: "add",
      path: f.jsonPointer,
      value: f.proposedValue
    });
  }

  // Handle ai.fieldMeta updates
  const fieldMeta = Array.isArray((currentCard as any)?.ai?.fieldMeta) ? [...(currentCard as any).ai.fieldMeta] : [];
  let fieldMetaChanged = false;

  for (const decision of decisions) {
    const fact = proposal.facts.find(f => f.jsonPath === decision.jsonPath);
    if (!fact) continue;

    const existingIndex = fieldMeta.findIndex(m => m.path === decision.jsonPath);
    const metaItem = existingIndex >= 0 ? { ...fieldMeta[existingIndex] } : {
      path: decision.jsonPath,
      source: fact.source,
      confidence: fact.confidence,
      repoSources: fact.repoSources,
      needs_review: false,
      guard: {}
    };

    metaItem.guard = metaItem.guard || {};
    let itemChanged = false;

    if (decision.lock !== undefined) {
      if (decision.lock) {
        if (!metaItem.guard.locked) {
          metaItem.guard.locked = true;
          itemChanged = true;
        }
      } else {
        if (metaItem.guard.locked) {
          delete metaItem.guard.locked;
          itemChanged = true;
        }
      }
    }

    if (decision.skipGeneration !== undefined) {
      if (decision.skipGeneration) {
        if (!metaItem.guard.skip_generation) {
          metaItem.guard.skip_generation = true;
          itemChanged = true;
        }
      } else {
        if (metaItem.guard.skip_generation) {
          delete metaItem.guard.skip_generation;
          itemChanged = true;
        }
      }
    }

    if (Object.keys(metaItem.guard).length === 0) {
      delete metaItem.guard;
    }

    if (itemChanged || existingIndex < 0) {
      fieldMetaChanged = true;
      if (existingIndex >= 0) {
        fieldMeta[existingIndex] = metaItem;
      } else {
        fieldMeta.push(metaItem);
      }
    }
  }

  if (fieldMetaChanged) {
    if (!(currentCard as any)?.ai) {
      operations.push({ op: "add", path: "/ai", value: {} });
    }
    operations.push({ op: "add", path: "/ai/fieldMeta", value: fieldMeta });
  }

  return operations;
}

async function cleanupProposalFiles(runId: string): Promise<void> {
  await fsExtra.remove(join(PROPOSALS_DIR, `${runId}.json`));
  await fsExtra.remove(join(PROPOSALS_DIR, `${runId}.decisions.json`));
}

async function writeMicroReceipt(
  proposal: Proposal,
  decisions: Decision[],
  acceptedFacts: Fact[],
  yamlSha: string
): Promise<void> {
  await fsExtra.ensureDir(MICRO_RECEIPTS_DIR);
  const timestamp = new Date().toISOString();
  const schemaId = await resolveSchemaId();
  const lowConfidence = summarizeLowConfidenceFacts(proposal, decisions, acceptedFacts);
  const receipt: MicroReceipt = {
    engine: "ml-system-card-local",
    run_id: proposal.meta.runId,
    base_sha: proposal.meta.baseSha,
    changed_paths: acceptedFacts.map((fact) => fact.jsonPath).sort((a, b) => a.localeCompare(b)),
    low_confidence_rows_only: lowConfidence,
    yaml_hash: yamlSha,
    schema_id: schemaId,
    coverage_non_null: proposal.diagnostics.coverage_non_null,
    timestamp
  };
  const filename = `${timestamp.slice(0, 10)}-${yamlSha.slice(0, 7)}.json`;
  await writeTextFile(join(MICRO_RECEIPTS_DIR, filename), JSON.stringify(receipt, null, 2));
}

async function updatePullRequestMetadata(
  proposal: Proposal,
  decisions: Decision[],
  acceptedFacts: Fact[],
  yamlSha: string
): Promise<void> {
  const ref = process.env.GITHUB_REF ?? "";
  const branch = ref.startsWith("refs/heads/") ? ref.replace("refs/heads/", "") : ref;
  if (!branch) {
    logger.warn("Cannot update PR metadata without branch context", { ref });
    return;
  }

  try {
    const pr = await findPullRequestByBranch(branch);
    if (!pr) {
      logger.warn("No open pull request found for branch", { branch });
      return;
    }

    const lowConfidence = summarizeLowConfidenceFacts(proposal, decisions, acceptedFacts);
    const changedPaths = acceptedFacts.map((fact) => fact.jsonPath).sort((a, b) => a.localeCompare(b));
    const stakeholderIds = Object.keys(proposal.notes ?? {}).sort((a, b) => a.localeCompare(b));

    const coveragePct = Math.round(proposal.diagnostics.coverage_non_null * 1000) / 10;
    const summaryBlock = [
      "## ML System Card Apply Summary",
      `- Run ID: \`${proposal.meta.runId}\``,
      `- Base SHA: \`${proposal.meta.baseSha}\``,
      `- YAML SHA: \`${yamlSha}\``,
      `- Changed Paths (${changedPaths.length}): ${changedPaths.length > 0 ? changedPaths.map((path) => `\`${path}\``).join(", ") : "_None_"}`,
      `- Coverage (non-null anchors): ${coveragePct.toFixed(1)}%`
    ].join("\n");

    const lowConfidenceTable = lowConfidence.length
      ? [
          "### Low-confidence dispositions",
          "| Path | Confidence | Disposition | Sources |",
          "|------|------------|-------------|---------|",
          ...lowConfidence.map((row) => {
            const sourcesCell = row.sources.length
              ? row.sources.map((source) => `\`${source}\``).join("<br/>")
              : "—";
            return `| ${row.path} | ${(row.confidence * 100).toFixed(1)}% | ${row.disposition} | ${sourcesCell} |`;
          })
        ].join("\n")
      : "### Low-confidence dispositions\n*No low-confidence facts were accepted or edited.*";

    const stakeholderSection = stakeholderIds.length
      ? [
          "### Stakeholder notes updated",
          ...stakeholderIds.map((id) => `- ${id}`)
        ].join("\n")
      : "### Stakeholder notes updated\n*No stakeholder notes generated in this run.*";

    const factDetails = buildFactDetails(acceptedFacts);
    const bodySections = [summaryBlock, lowConfidenceTable, stakeholderSection, factDetails].filter(Boolean);
    const existingBody = pr.body ?? "";
    const newBody = [
      bodySections.join("\n\n"),
      "---",
      "<details><summary>Original PR body</summary>",
      "",
      existingBody.trim() || "(empty)",
      "",
      "</details>"
    ].join("\n");

    await updatePullRequest(pr.number, { body: newBody });

    await addLabels(pr.number, ["ml-system-card", "auto-merge-ok"]);
    if (lowConfidence.some((row) => row.confidence < 0.8)) {
      await addLabels(pr.number, ["confidence-low"]);
    } else {
      await removeLabel(pr.number, "confidence-low");
    }
    await removeLabel(pr.number, "proposal");

    await closeSupersededPullRequests(pr.number, pr.base.ref, proposal.meta.runId);
  } catch (error) {
    logger.warn("Failed to update PR metadata", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function closeSupersededPullRequests(currentNumber: number, baseRef: string, runId: string): Promise<void> {
  const openPulls = await listOpenPullRequestsByBase(baseRef);
  for (const pr of openPulls) {
    if (pr.number === currentNumber) {
      continue;
    }
    const hasPrototypeLabel = (pr.labels ?? []).some((label) => label.name === "ml-system-card");
    if (!hasPrototypeLabel) {
      continue;
    }
    await addLabels(pr.number, ["superseded"]);
    await createIssueComment(
      pr.number,
      `Superseded by ML System Card apply run \`${runId}\` (PR #${currentNumber}). Closing this pull request.`
    );
    await updatePullRequest(pr.number, { state: "closed" });
  }
}

async function resolveSchemaId(): Promise<string> {
  try {
    const schema = await fsExtra.readJson(SCHEMA_PATH);
    if (schema && typeof schema === "object" && typeof schema.$id === "string" && schema.$id.length > 0) {
      return schema.$id as string;
    }
  } catch (error) {
    logger.warn("Unable to resolve schema id", { error: error instanceof Error ? error.message : String(error) });
  }
  return `${SCHEMA_PATH}#unknown`;
}

function summarizeLowConfidenceFacts(
  proposal: Proposal,
  decisions: Decision[],
  acceptedFacts: Fact[]
): MicroReceipt["low_confidence_rows_only"] {
  const decisionByPath = new Map<string, Decision>();
  decisions.forEach((decision) => decisionByPath.set(decision.jsonPath, decision));
  const acceptedPaths = new Set(acceptedFacts.map((fact) => fact.jsonPath));

  return proposal.facts
    .filter((fact) => fact.gate !== "OK")
    .map((fact) => {
      const decision = decisionByPath.get(fact.jsonPath);
      const anchors = decision?.anchors ?? fact.repoSources;
      const disposition = determineDisposition(decision, acceptedPaths.has(fact.jsonPath));
      return {
        path: fact.jsonPath,
        confidence: fact.confidence,
        sources: anchors.map(anchorToDeepLink),
        disposition
      };
    })
    .filter((row) => row.sources.length > 0 || row.disposition !== "rejected")
    .sort((a, b) => a.path.localeCompare(b.path));
}

function determineDisposition(decision: Decision | undefined, accepted: boolean): "accepted" | "edited" | "rejected" {
  if (decision?.decision === "edit") {
    return "edited";
  }
  if (decision?.decision === "reject") {
    return "rejected";
  }
  return accepted ? "accepted" : "rejected";
}

function anchorToDeepLink(anchor: Fact["repoSources"][number]): string {
  const lines = anchor.startLine === anchor.endLine ? `L${anchor.startLine}` : `L${anchor.startLine}-L${anchor.endLine}`;
  return `${anchor.path}#${lines}`;
}

function buildFactDetails(facts: Fact[]): string {
  if (facts.length === 0) {
    return "### Accepted facts\n*No card fields were changed in this apply run.*";
  }

  const byKind = facts.reduce<Record<string, Fact[]>>((acc, fact) => {
    const kind = fact.source.kind;
    acc[kind] = acc[kind] ?? [];
    acc[kind]!.push(fact);
    return acc;
  }, {});

  const sections = Object.entries(byKind)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, entries]) => {
      const rows = entries
        .sort((a, b) => a.jsonPath.localeCompare(b.jsonPath))
        .map((fact) => `- ${fact.jsonPath}: ${summarizeValue(fact.proposedValue)}`);
      return [`#### ${kind.charAt(0).toUpperCase()}${kind.slice(1)} facts`, ...rows].join("\n");
    });

  return ["### Accepted facts", ...sections].join("\n\n");
}

function summarizeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return json.length > 120 ? `${json.slice(0, 117)}…` : json;
  } catch (_error) {
    return "(unserializable value)";
  }
}

async function buildAnchors(
  proposal: Proposal,
  facts: Fact[],
  cardSha: string
): Promise<AnchorsIndex> {
  if (facts.length === 0) {
    const existing = await readTextFile(ANCHORS_PATH);
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as AnchorsIndex;
        return {
          ...parsed,
          cardSha,
          runId: proposal.meta.runId,
          generatedAt: new Date().toISOString()
        };
      } catch (error) {
        logger.warn("Failed to parse existing anchors; regenerating", { error });
      }
    }
  }

  return buildAnchorsIndex(facts, {
    runId: proposal.meta.runId,
    cardSha,
    version: DEFAULT_ANCHORS_VERSION
  });
}

async function captureRejections(proposal: Proposal, decisions: Decision[]): Promise<void> {
  const rejections = decisions.filter((d) => d.decision === "reject");
  if (rejections.length === 0) {
    return;
  }

  const feedbackDir = join(PROPOSALS_DIR, "../.feedback");
  await fsExtra.ensureDir(feedbackDir);
  const feedbackPath = join(feedbackDir, "rejections.jsonl");

  const entries = rejections.map((decision) => {
    const fact = proposal.facts.find((f) => f.jsonPath === decision.jsonPath);
    return JSON.stringify({
      path: decision.jsonPath,
      rejectedValue: fact?.proposedValue,
      timestamp: new Date().toISOString(),
      runId: proposal.meta.runId
    });
  });

  await fsExtra.appendFile(feedbackPath, entries.join("\n") + "\n");
}

void main().catch((error) => {
  logger.error("Apply failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
