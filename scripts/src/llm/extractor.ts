import { createHash } from "node:crypto";
import { join } from "node:path";

import { loadProjectContext } from "../analysis/learning.js";
import fsExtra from "fs-extra";
import type { Anchor, Fact, Gate } from "lib/card/types.js";

import {
  PROPOSALS_DIR,
  EXTRACTOR_ARTIFACT_SUFFIX,
  SAFETY_LIMITS
} from "../constants.js";
import { writeJsonFile } from "../utils/fs.js";
import { logger } from "../utils/logger.js";
import { loadPromptTemplate } from "../utils/prompts.js";
import { runDeterministicPipeline } from "../pipeline/deterministic.js";
import { invokeChatCompletion } from "./client.js";
import {
  computeEvidenceTokenBudget,
  formatBaseCard,
  formatEvidenceForPrompt,
  formatPolicyRules,
  formatRunMetadata
} from "./formatters.js";
import type { PassContext, ExtractorResult } from "./types.js";

interface ExtractorArtifact {
  promptId: string;
  promptMetadata: Record<string, unknown>;
  promptDigest: string;
  mode: string;
  facts: Fact[];
  deterministicFallbackFacts: Fact[];
  message: string;
  analysisArtifact: string;
  generatedAt: string;
  attempts: number;
  retryReasons: string[];
  llm?: {
    provider: string | null;
    model: string | null;
    promptPreview?: string;
    contentPreview?: string;
    requestDigest: string | null;
    responseDigest: string | null;
    metrics: {
      promptTokens: number;
      completionTokens: number;
      latencyMs: number;
    };
  };
}

interface RawFactPayload {
  jsonPath?: string;
  jsonPointer?: string;
  proposedValue?: unknown;
  currentValue?: unknown;
  repoSources?: Array<Partial<Anchor>>;
  confidence?: number;
  gate?: Gate;
  verifierNotes?: string;
  source?: { kind?: Fact["source"]["kind"] };
}

export async function runExtractorPass(context: PassContext): Promise<ExtractorResult> {
  const prompt = await loadPromptTemplate("extractor.v1.md");
  const deterministic = runDeterministicPipeline({
    baselineCard: context.baselineCard,
    changedFiles: context.analysis.changedFiles,
    insights: context.analysis.repository
  });

  const minConfidence = context.runtime.sampling.retryPolicy.minConfidence;
  const feedback = await loadFeedback();
  const basePrompt = (await renderExtractorPrompt(context, prompt.body, minConfidence)) + (feedback ? `\n\n${feedback}` : "");
  const fallbackResponse = JSON.stringify({ facts: deterministic.facts });

  const maxAttempts = Math.max(1, context.runtime.sampling.retryPolicy.maxAttempts);
  let attemptsUsed = 0;
  let retryReasons: string[] = [];
  let lastPromptBody = basePrompt;
  let promptAugmentation = "";

  let mode: "deterministic" | "llm" = "deterministic";
  let llmTrace: ExtractorResult["llm"] = null;
  let metrics = { promptTokens: 0, completionTokens: 0, latencyMs: 0 };
  let llmResponseContent = fallbackResponse;
  let resolvedFacts: Fact[] = deterministic.facts;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsUsed = attempt;
    const attemptPrompt = promptAugmentation
      ? `${basePrompt}\n\n### Retry Guidance\n${promptAugmentation.trim()}`
      : basePrompt;
    lastPromptBody = attemptPrompt;

    try {
      let result;
      try {
        result = await invokeChatCompletion(context.runtime, {
          promptId: prompt.id,
          temperature: context.runtime.sampling.extractor.temperature,
          topP: context.runtime.sampling.extractor.topP,
          maxTokens: context.runtime.sampling.extractor.maxTokens,
          reasoningEffort: context.runtime.sampling.extractor.reasoningEffort,
          verbosity: context.runtime.sampling.extractor.verbosity,
          messages: [
            {
              role: "system",
              content: (prompt.metadata.system as string) ?? "You are a repository analyzer."
            },
            { role: "user", content: lastPromptBody }
          ],
          fallbackResponse,
          jsonMode: true
        });
      } catch (primaryError) {
        // Downgrade strategy for high-reasoning models
        const currentEffort = context.runtime.sampling.extractor.reasoningEffort;
        // Cast to string to avoid TS overlap errors if types are strict
        const effortStr = String(currentEffort);

        if (effortStr === "high" || effortStr === "medium") {
          const newEffort = effortStr === "high" ? "medium" : "low";
          logger.warn(`Extractor LLM failed with ${currentEffort} reasoning; downgrading to ${newEffort}`, {
            error: primaryError instanceof Error ? primaryError.message : String(primaryError)
          });

          result = await invokeChatCompletion(context.runtime, {
            promptId: prompt.id,
            temperature: context.runtime.sampling.extractor.temperature,
            topP: context.runtime.sampling.extractor.topP,
            maxTokens: context.runtime.sampling.extractor.maxTokens,
            reasoningEffort: newEffort as "medium" | "low",
            verbosity: context.runtime.sampling.extractor.verbosity,
            messages: [
              {
                role: "system",
                content: (prompt.metadata.system as string) ?? "You are a repository analyzer."
              },
              { role: "user", content: lastPromptBody }
            ],
            fallbackResponse,
            jsonMode: true
          });
        } else {
          throw primaryError;
        }
      }

      llmResponseContent = result.content;
      metrics = {
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        latencyMs: result.latencyMs
      };

      if (result.mode === "network") {
        mode = "llm";
        llmTrace = {
          provider: context.runtime.provider,
          model: context.runtime.model,
          requestDigest: result.requestDigest,
          responseDigest: result.responseDigest
        };
      } else {
        mode = "deterministic";
        llmTrace = null;
      }
    } catch (error) {
      logger.warn("Extractor LLM invocation failed; using deterministic fallback", {
        runId: context.runId,
        attempt,
        error: error instanceof Error ? error.message : String(error)
      });
      mode = "deterministic";
      llmTrace = null;
      llmResponseContent = fallbackResponse;
    }

    const rawFacts = parseExtractorFacts(llmResponseContent);
    if (!rawFacts) {
      logger.warn("Extractor response invalid; falling back to deterministic", {
        attempt,
        contentPreview: llmResponseContent.slice(0, 500)
      });
      mode = "deterministic";
      llmTrace = null;
    }

    let mergedFacts = mergeFacts(rawFacts ?? [], deterministic.facts, context.analysis.metadata.headSha);
    if (mergedFacts.length > SAFETY_LIMITS.maxFacts) {
      logger.warn("Extractor produced more facts than allowed; trimming", {
        produced: mergedFacts.length,
        limit: SAFETY_LIMITS.maxFacts,
        attempt
      });
      mergedFacts = mergedFacts.slice(0, SAFETY_LIMITS.maxFacts);
    }

    resolvedFacts = mergedFacts;
    retryReasons = collectExtractorRetryReasons(mergedFacts, minConfidence);

    const shouldRetry =
      retryReasons.length > 0 &&
      attempt < maxAttempts &&
      mode === "llm";

    if (!shouldRetry) {
      break;
    }

    promptAugmentation = buildRetryGuidance(retryReasons);
  }

  const artifactPromptDigest = createHash("sha256").update(lastPromptBody).digest("hex");

  const artifact: ExtractorArtifact = {
    promptId: prompt.id,
    promptMetadata: prompt.metadata,
    promptDigest: artifactPromptDigest,
    mode,
    facts: resolvedFacts,
    deterministicFallbackFacts: deterministic.facts,
    message:
      mode === "llm"
        ? retryReasons.length === 0
          ? "Extractor completed with live LLM orchestration."
          : "Extractor exhausted retries; review low-confidence facts."
        : "Extractor relied on deterministic fallback output.",
    analysisArtifact: context.analysis.artifactPath,
    generatedAt: new Date().toISOString(),
    attempts: attemptsUsed,
    retryReasons
  };

  if (llmTrace) {
    artifact.llm = {
      provider: llmTrace.provider,
      model: llmTrace.model,
      requestDigest: llmTrace.requestDigest,
      responseDigest: llmTrace.responseDigest,
      metrics
    };
    if (!context.runtime.privacyMode) {
      artifact.llm.promptPreview = lastPromptBody.slice(0, 2000);
      artifact.llm.contentPreview = llmResponseContent.slice(0, 2000);
    }
  }

  await fsExtra.ensureDir(PROPOSALS_DIR);
  const artifactPath = join(PROPOSALS_DIR, `${context.runId}${EXTRACTOR_ARTIFACT_SUFFIX}`);
  await writeJsonFile(artifactPath, artifact);
  const artifactDigest = createHash("sha256").update(JSON.stringify(artifact)).digest("hex");

  logger.info("Extractor pass recorded", {
    runId: context.runId,
    mode,
    artifact: artifactPath,
    facts: resolvedFacts.length,
    attempts: attemptsUsed,
    remainingLowConfidence: retryReasons.length
  });

  return {
    artifactPath,
    artifactDigest,
    promptId: prompt.id,
    mode,
    facts: resolvedFacts,
    metrics,
    llm: llmTrace,
    attempts: attemptsUsed,
    retryReasons
  };
}

async function renderExtractorPrompt(context: PassContext, template: string, minConfidence: number): Promise<string> {
  // Compute a dynamic evidence budget based on the model's context window
  const maxOutputTokens = context.runtime.sampling.extractor.maxTokens;
  const evidenceBudget = computeEvidenceTokenBudget(context.runtime.model, maxOutputTokens);
  logger.info("Evidence token budget computed", {
    model: context.runtime.model,
    maxOutputTokens,
    evidenceBudget,
    envOverride: process.env.LLM_CONTEXT_WINDOW ?? "none"
  });

  const replacements = new Map<string, string>([
    ["{RUN_METADATA}", formatRunMetadata(context)],
    ["{BASE_CARD}", formatBaseCard(context.baselineCard)],
    ["{EVIDENCE_TABLE}", await formatEvidenceForPrompt(context.analysis, evidenceBudget)],
    ["{MIN_CONFIDENCE}", minConfidence.toFixed(2)],
    ["{POLICY_RULES}", formatPolicyRules(minConfidence)]
  ]);
  let rendered = template;
  for (const [placeholder, value] of replacements.entries()) {
    rendered = rendered.replaceAll(placeholder, value);
  }
  return rendered;
}

function collectExtractorRetryReasons(facts: Fact[], minConfidence: number): string[] {
  const reasons: string[] = [];
  const lowConfidence = facts.filter((fact) => fact.confidence < minConfidence);
  const missingAnchors = facts.filter((fact) => fact.repoSources.length === 0);
  const requireFacts = facts.filter((fact) => fact.gate === "Require");

  if (lowConfidence.length > 0) {
    const sample = lowConfidence.slice(0, 5).map((fact) => fact.jsonPath).join(", ");
    reasons.push(
      `Raise confidence to >= ${(minConfidence * 100).toFixed(0)}% for: ${sample}${
        lowConfidence.length > 5 ? "…" : ""
      }`
    );
  }
  if (missingAnchors.length > 0) {
    const sample = missingAnchors.slice(0, 5).map((fact) => fact.jsonPath).join(", ");
    reasons.push(
      `Provide repository anchors for: ${sample}${missingAnchors.length > 5 ? "…" : ""}`
    );
  }
  if (requireFacts.length > 0) {
    const sample = requireFacts.slice(0, 5).map((fact) => fact.jsonPath).join(", ");
    reasons.push(`Resolve Require-gated facts: ${sample}${requireFacts.length > 5 ? "…" : ""}`);
  }

  return reasons;
}

function buildRetryGuidance(reasons: string[]): string {
  if (reasons.length === 0) {
    return "";
  }
  return reasons.map((reason) => `- ${reason}`).join("\n");
}

function parseExtractorFacts(raw: string): RawFactPayload[] | null {
  const cleaned = stripCodeFences(raw.trim());
  if (!cleaned) {
    return null;
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed as RawFactPayload[];
    }
    if (parsed && Array.isArray(parsed.facts)) {
      return parsed.facts as RawFactPayload[];
    }
    return null;
  } catch (error) {
    logger.warn("Extractor response was not valid JSON", {
      error: error instanceof Error ? error.message : String(error),
      snippet: cleaned.slice(0, 200)
    });
    return null;
  }
}

function mergeFacts(rawFacts: RawFactPayload[], baselineFacts: Fact[], headSha: string): Fact[] {
  if (rawFacts.length === 0) {
    return baselineFacts;
  }

  // Paths managed exclusively by the deterministic pipeline — never accept LLM overrides
  const DETERMINISTIC_ONLY_PREFIXES = ["$.provenance.changelog", "$.meta.createdAt", "$.meta.lastUpdated", "$.ai."];

  const map = new Map<string, Fact>();
  baselineFacts.forEach((fact) => {
    map.set(fact.jsonPath, { ...fact, repoSources: fact.repoSources.map((anchor) => ({ ...anchor })) });
  });

  for (const candidate of rawFacts) {
    if (!candidate.jsonPath) {
      continue;
    }
    // Skip LLM facts that collide with deterministic-only paths
    if (DETERMINISTIC_ONLY_PREFIXES.some((prefix) => candidate.jsonPath!.startsWith(prefix))) {
      continue;
    }
    const existing = map.get(candidate.jsonPath);
    if (!existing) {
      let pointer = candidate.jsonPointer;
      if (!pointer && candidate.jsonPath) {
        // Attempt to derive pointer from path if missing (common with high-reasoning models)
        pointer = candidate.jsonPath
          .replace(/^\$\.?/, "")
          .replace(/\./g, "/")
          .replace(/\[(\d+)\]/g, "/$1");

        if (!pointer.startsWith("/")) {
          pointer = "/" + pointer;
        }
      }

      if (!pointer) {
        continue;
      }
      const normalizedAnchors = normalizeAnchors(candidate.repoSources ?? [], headSha);
      if (normalizedAnchors.length === 0) {
        continue;
      }
      map.set(candidate.jsonPath, {
        jsonPath: candidate.jsonPath,
        jsonPointer: pointer,
        currentValue: candidate.currentValue,
        proposedValue: candidate.proposedValue,
        source: { kind: candidate.source?.kind ?? "extracted" },
        repoSources: normalizedAnchors,
        confidence: normalizeConfidence(candidate.confidence, 0.75),
        gate: candidate.gate ?? computeGate(normalizeConfidence(candidate.confidence, 0.75)),
        verifierNotes: candidate.verifierNotes
      });
      continue;
    }

    const normalizedAnchors = normalizeAnchors(candidate.repoSources ?? [], headSha);
    const mergedAnchors = normalizedAnchors.length > 0 ? normalizedAnchors : existing.repoSources;
    const confidence = normalizeConfidence(candidate.confidence, existing.confidence);
    map.set(candidate.jsonPath, {
      jsonPath: existing.jsonPath,
      jsonPointer: candidate.jsonPointer ?? existing.jsonPointer,
      currentValue: existing.currentValue,
      proposedValue: candidate.proposedValue ?? existing.proposedValue,
      source: {
        kind: candidate.source?.kind ?? existing.source.kind
      },
      repoSources: mergedAnchors,
      confidence,
      gate: candidate.gate ?? computeGate(confidence),
      verifierNotes: candidate.verifierNotes ?? existing.verifierNotes
    });
  }

  return Array.from(map.values()).sort((a, b) => a.jsonPath.localeCompare(b.jsonPath));
}

function normalizeAnchors(anchors: Array<Partial<Anchor>>, headSha: string): Anchor[] {
  const SHA_REGEX = /^[0-9a-fA-F]{7,40}$/;
  const VALID_KINDS = ["code", "openapi", "metrics", "docs", "config", "test"];

  return anchors
    .filter((anchor) => typeof anchor?.path === "string")
    .map((anchor) => {
      let commit = typeof anchor.commit === "string" ? anchor.commit : headSha;
      if (!SHA_REGEX.test(commit)) {
        commit = headSha;
      }

      let kind = anchor.kind as Anchor["kind"];
      if (!VALID_KINDS.includes(kind as string)) {
        if (anchor.path?.endsWith(".md")) kind = "docs";
        else if (anchor.path?.endsWith(".json") || anchor.path?.endsWith(".yaml")) kind = "config";
        else kind = "code";
      }

      return {
        path: anchor.path as string,
        startLine: typeof anchor.startLine === "number" ? anchor.startLine : 1,
        endLine: typeof anchor.endLine === "number" ? anchor.endLine : anchor.startLine ?? 1,
        commit,
        kind
      };
    })
    .filter((anchor) => anchor.path.length > 0);
}

function normalizeConfidence(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0) {
      return 0;
    }
    if (value > 1) {
      return 1;
    }
    return value;
  }
  return fallback;
}

function computeGate(confidence: number): Gate {
  if (confidence >= 0.8) {
    return "OK";
  }
  if (confidence >= 0.65) {
    return "Warn";
  }
  return "Require";
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

async function loadFeedback(): Promise<string> {
  const projectContext = await loadProjectContext();
  const feedbackPath = join(PROPOSALS_DIR, "../.feedback/rejections.jsonl");

  let negativeFeedback = "";

  if (fsExtra.existsSync(feedbackPath)) {
    const content = await fsExtra.readFile(feedbackPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const rejections = lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter((x): x is any => Boolean(x));

    if (rejections.length > 0) {
      // Group by path to summarize
      const byPath: Record<string, any[]> = {};
      for (const r of rejections) {
        byPath[r.path] = byPath[r.path] || [];
        byPath[r.path].push(r.rejectedValue);
      }

      const summary = Object.entries(byPath).map(([path, values]) => {
        return `- Path: \`${path}\`\n  Rejected Values: ${values.map((v) => JSON.stringify(v)).join(", ")}`;
      }).join("\n");

      negativeFeedback = `### Negative Feedback (Do Not Repeat)\nThe following values were previously rejected by reviewers. Do not propose them again unless the code has significantly changed.\n\n${summary}`;
    }
  }

  const parts = [];
  if (projectContext) parts.push(`### Project Context\n${projectContext}`);
  if (negativeFeedback) parts.push(negativeFeedback);

  return parts.join("\n\n");
}

export const FACT_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          jsonPath: { type: "string" },
          jsonPointer: { type: "string" },
          proposedValue: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "object", additionalProperties: true },
              { type: "array", items: {} },
              { type: "null" }
            ]
          },
          currentValue: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "object", additionalProperties: true },
              { type: "array", items: {} },
              { type: "null" }
            ]
          },
          source: {
            type: "object",
            properties: { kind: { type: "string", enum: ["extracted", "inferred", "manual"] } },
            required: ["kind"],
            additionalProperties: false
          },
          repoSources: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                startLine: { type: "number" },
                endLine: { type: "number" },
                commit: { type: "string" },
                kind: { type: "string" }
              },
              required: ["path", "startLine", "endLine", "commit", "kind"],
              additionalProperties: false
            }
          },
          confidence: { type: "number" },
          gate: { type: "string", enum: ["OK", "Warn", "Require"] },
          verifierNotes: { type: "string" }
        },
        required: ["jsonPath", "jsonPointer", "proposedValue", "currentValue", "source", "repoSources", "confidence", "gate", "verifierNotes"],
        additionalProperties: false
      }
    }
  },
  required: ["facts"],
  additionalProperties: false
};
