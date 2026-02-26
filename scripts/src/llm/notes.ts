import { createHash } from "node:crypto";
import { join } from "node:path";

import fsExtra from "fs-extra";
import type { Fact, Proposal } from "lib/card/types.js";

import { PROPOSALS_DIR, NOTES_ARTIFACT_SUFFIX, SAFETY_LIMITS } from "../constants.js";
import { buildStakeholderNotes } from "../pipeline/deterministic.js";
import { writeJsonFile } from "../utils/fs.js";
import { logger } from "../utils/logger.js";
import { loadPromptTemplate } from "../utils/prompts.js";
import { invokeChatCompletion } from "./client.js";
import {
  formatRunMetadata,
  summarizeFactsForStakeholder
} from "./formatters.js";

interface NotesArtifact {
  promptId: string;
  promptMetadata: Record<string, unknown>;
  mode: string;
  notes: Proposal["notes"];
  deterministicFallback: Proposal["notes"];
  reasonerArtifact: string;
  analysisArtifact: string;
  generatedAt: string;
  perStakeholder: Array<{
    stakeholderId: string;
    promptDigest: string;
    usedFallback: boolean;
    note: Proposal["notes"][string] | null;
    fallback: Proposal["notes"][string] | null;
    llm?: {
      requestDigest: string | null;
      responseDigest: string | null;
      promptPreview?: string;
      contentPreview?: string;
    };
  }>;
  llm?: {
    provider: string | null;
    model: string | null;
    requestDigest: string | null;
    responseDigest: string | null;
    metrics: {
      promptTokens: number;
      completionTokens: number;
      latencyMs: number;
    };
  };
}

interface NotePayload {
  note?: { textMd?: string; overview?: string; changes?: string; confidence: number } | null;
}

import type { PassContext, ReasonerResult, NotesResult, VerifierResult } from "./types.js";

// ...existing code...

export async function runNotesPass(
  context: PassContext,
  input: ReasonerResult | VerifierResult
): Promise<NotesResult> {
  const prompt = await loadPromptTemplate("notes.v1.md");
  const fallbackNotes = buildStakeholderNotes(input.facts);
  const stakeholderIds = deriveStakeholderIds(context, fallbackNotes).slice(0, SAFETY_LIMITS.maxNotes);

  const aggregateMetrics = { promptTokens: 0, completionTokens: 0, latencyMs: 0 };
  const requestDigests: string[] = [];
  const responseDigests: string[] = [];
  let networkModeUsed = false;

  const finalNotes: Proposal["notes"] = {};
  const perStakeholder: NotesArtifact["perStakeholder"] = [];

  for (const stakeholderId of stakeholderIds) {
    const baselineFallback = resolveBaselineNote(context, stakeholderId);
    const fallback = fallbackNotes[stakeholderId] ?? baselineFallback;
    const renderedPrompt = renderNotesPrompt(context, input.facts, stakeholderId, prompt.body);
    const fallbackResponse = JSON.stringify({ note: fallback });

    let usedFallback = false;
    let usedNetwork = false;
    let llmRequestDigest: string | null = null;
    let llmResponseDigest: string | null = null;
    let llmContent = fallbackResponse;

    try {
      const result = await invokeChatCompletion(context.runtime, {
        promptId: `${prompt.id}:${stakeholderId}`,
        temperature: context.runtime.sampling.notes.temperature,
        topP: context.runtime.sampling.notes.topP,
        maxTokens: context.runtime.sampling.notes.maxTokens,
        reasoningEffort: context.runtime.sampling.notes.reasoningEffort,
        messages: [
          {
            role: "system",
            content: (prompt.metadata.system as string) ?? "You craft stakeholder notes for ML System Card updates."
          },
          { role: "user", content: renderedPrompt }
        ],
        fallbackResponse,
        jsonMode: true
      });
      llmContent = result.content;
      aggregateMetrics.promptTokens += result.promptTokens;
      aggregateMetrics.completionTokens += result.completionTokens;
      aggregateMetrics.latencyMs += result.latencyMs;
      llmRequestDigest = result.requestDigest;
      llmResponseDigest = result.responseDigest;
      if (result.mode === "network") {
        usedNetwork = true;
        networkModeUsed = true;
        if (result.requestDigest) {
          requestDigests.push(result.requestDigest);
        }
        if (result.responseDigest) {
          responseDigests.push(result.responseDigest);
        }
      } else {
        usedFallback = true;
      }
    } catch (error) {
      logger.warn("Notes LLM invocation failed; using deterministic fallback", {
        runId: context.runId,
        stakeholderId,
        error: error instanceof Error ? error.message : String(error)
      });
      usedFallback = true;
      llmContent = fallbackResponse;
    }

    const parsed = parseNoteResponse(llmContent);
    const note = normalizeNote(parsed.note, fallback);
    if (note) {
      finalNotes[stakeholderId] = note;
    }

    const entry: NotesArtifact["perStakeholder"][number] = {
      stakeholderId,
      promptDigest: createHash("sha256").update(renderedPrompt).digest("hex"),
      usedFallback: usedFallback || llmContent === fallbackResponse,
      note,
      fallback
    };

    if (usedNetwork) {
      entry.llm = {
        requestDigest: llmRequestDigest,
        responseDigest: llmResponseDigest
      };
      if (!context.runtime.privacyMode) {
        entry.llm.promptPreview = renderedPrompt.slice(0, 1200);
        entry.llm.contentPreview = llmContent.slice(0, 1200);
      }
    }

    perStakeholder.push(entry);
  }

  const mode = networkModeUsed ? "llm" : "deterministic";

  const artifact: NotesArtifact = {
    promptId: prompt.id,
    promptMetadata: prompt.metadata,
    mode,
    notes: finalNotes,
    deterministicFallback: fallbackNotes,
    reasonerArtifact: input.artifactPath,
    analysisArtifact: context.analysis.artifactPath,
    generatedAt: new Date().toISOString(),
    perStakeholder
  };

  if (networkModeUsed) {
    artifact.llm = {
      provider: context.runtime.provider,
      model: context.runtime.model,
      requestDigest: digestList(requestDigests),
      responseDigest: digestList(responseDigests),
      metrics: aggregateMetrics
    };
  }

  await fsExtra.ensureDir(PROPOSALS_DIR);
  const artifactPath = join(PROPOSALS_DIR, `${context.runId}${NOTES_ARTIFACT_SUFFIX}`);
  await writeJsonFile(artifactPath, artifact);
  const artifactDigest = createHash("sha256").update(JSON.stringify(artifact)).digest("hex");

  logger.info("Notes pass recorded", {
    runId: context.runId,
    mode,
    stakeholders: stakeholderIds.length,
    artifact: artifactPath
  });

  return {
    artifactPath,
    artifactDigest,
    promptId: prompt.id,
    mode,
    notes: finalNotes,
    metrics: aggregateMetrics,
    llm: networkModeUsed
      ? {
          provider: context.runtime.provider,
          model: context.runtime.model,
          requestDigest: digestList(requestDigests),
          responseDigest: digestList(responseDigests)
        }
      : null,
    attempts: 1,
    retryReasons: []
  } satisfies NotesResult;
}

function deriveStakeholderIds(
  context: PassContext,
  fallbackNotes: Proposal["notes"]
): string[] {
  const seeds = new Set<string>();
  Object.keys(context.baselineCard.stakeholderNotes ?? {}).forEach((id) => seeds.add(id));
  Object.keys(fallbackNotes).forEach((id) => seeds.add(id));
  const repositoryRoles = context.analysis.repository.userPopulations ?? [];
  repositoryRoles.forEach((role) => seeds.add(slugify(role)));
  return Array.from(seeds).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function resolveBaselineNote(
  context: PassContext,
  stakeholderId: string
): { textMd: string; confidence: number } | null {
  const raw = context.baselineCard.stakeholderNotes?.[stakeholderId];
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const text = typeof (raw as any).textMd === "string" ? (raw as any).textMd : null;
  const confidence = typeof (raw as any).confidence === "number" ? (raw as any).confidence : 0.75;
  if (!text) {
    return null;
  }
  return { textMd: text, confidence: clamp01(confidence) };
}

function renderNotesPrompt(
  context: PassContext,
  facts: Fact[],
  stakeholderId: string,
  template: string
): string {
  const replacements = new Map<string, string>([
    ["{RUN_METADATA}", formatRunMetadata(context)],
    ["{STAKEHOLDER_PROFILE}", formatStakeholderProfile(context, stakeholderId)],
    ["{FACT_SUMMARY}", summarizeFactsForStakeholder(facts, stakeholderId)],
    ["{DELTA_SUMMARY}", formatDeltaSummary(facts, stakeholderId)]
  ]);
  let rendered = template;
  for (const [placeholder, value] of replacements.entries()) {
    rendered = rendered.replaceAll(placeholder, value);
  }
  return rendered;
}

function parseNoteResponse(raw: string): { note?: { textMd?: string; overview?: string; changes?: string; confidence: number } } {
  const cleaned = stripCodeFences(raw.trim());
  if (!cleaned) {
    return { note: undefined };
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return { note: undefined };
  } catch (error) {
    logger.warn("Notes response was not valid JSON", {
      error: error instanceof Error ? error.message : String(error),
      snippet: cleaned.slice(0, 200)
    });
    return { note: undefined };
  }
}

function normalizeNote(
  candidate: { textMd?: string; overview?: string; changes?: string; confidence: number } | undefined | null,
  fallback: Proposal["notes"][string] | null
): Proposal["notes"][string] | null {
  if (candidate && typeof candidate === "object") {
    // New style: specific fields
    if (typeof candidate.overview === "string" || typeof candidate.changes === "string") {
      const confidence = clamp01(
        typeof candidate.confidence === "number" ? candidate.confidence : fallback?.confidence ?? 0.75
      );
      return {
        textMd: candidate.textMd?.trim().slice(0, 1200) ?? "", // Optional/Legacy
        overview: candidate.overview?.trim().slice(0, 800),
        changes: candidate.changes?.trim().slice(0, 800),
        confidence
      };
    }

    // Legacy style
    if (typeof candidate.textMd === "string") {
       const confidence = clamp01(
        typeof candidate.confidence === "number" ? candidate.confidence : fallback?.confidence ?? 0.75
      );
      return {
        textMd: candidate.textMd.trim().slice(0, 1200),
        confidence
      };
    }
  }
  return fallback ?? null;
}

function formatStakeholderProfile(context: PassContext, stakeholderId: string): string {
  const baseline = resolveBaselineNote(context, stakeholderId);
  const populations = context.analysis.repository.userPopulations ?? [];
  const match = populations.find((role) => slugify(role) === stakeholderId) ?? populations[0] ?? "unspecified";
  const lines = [
    `Stakeholder ID: ${stakeholderId}`,
    `Related population: ${match}`,
    `Repository languages: ${context.analysis.repository.languages.join(", ") || "unknown"}`
  ];
  if (baseline?.textMd) {
    lines.push(`Previous note excerpt: ${truncate(baseline.textMd, 200)}`);
  }
  return lines.join("\n");
}

function formatDeltaSummary(facts: Fact[], stakeholderId: string): string {
  const focus = stakeholderFocus(stakeholderId);
  const candidates = facts.filter((fact) => fact.jsonPath.includes(focus));
  const selected = candidates.length > 0 ? candidates : facts.slice(0, Math.min(5, facts.length));
  if (selected.length === 0) {
    return "No fact deltas matched this stakeholder; emphasize run metadata.";
  }
  return selected
    .map((fact) => {
      const value = stringifyValue(fact.proposedValue, 80);
      return `- ${fact.jsonPath}: ${value} (confidence ${(fact.confidence * 100).toFixed(0)}%, anchors ${fact.repoSources.length})`;
    })
    .join("\n");
}

function digestList(values: string[]): string | null {
  if (values.length === 0) {
    return null;
  }
  return createHash("sha256").update(values.sort().join("|")).digest("hex");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim();
}

function stakeholderFocus(stakeholderId: string): string {
  if (stakeholderId.includes("product")) {
    return "$.business";
  }
  if (stakeholderId.includes("governance")) {
    return "$.governance";
  }
  if (stakeholderId.includes("ml") || stakeholderId.includes("engineer")) {
    return "$.devInsight";
  }
  return "$.business";
}

function stringifyValue(value: unknown, maxLength: number): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (!serialized) {
    return "<none>";
  }
  if (serialized.length <= maxLength) {
    return serialized;
  }
  return `${serialized.slice(0, maxLength - 3)}...`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function stripCodeFences(content: string): string {
  if (!content.startsWith("```")) {
    return content;
  }
  const lines = content.split(/\r?\n/);
  if (lines.length < 3) {
    return content;
  }
  return lines.slice(1, -1).join("\n");
}
