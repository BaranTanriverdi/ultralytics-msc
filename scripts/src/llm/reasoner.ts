import { createHash } from "node:crypto";
import { join } from "node:path";

import fsExtra from "fs-extra";
import type { Fact } from "lib/card/types.js";

import { PROPOSALS_DIR, REASONER_ARTIFACT_SUFFIX } from "../constants.js";
import { runDeterministicPipeline } from "../pipeline/deterministic.js";
import { writeJsonFile } from "../utils/fs.js";
import { logger } from "../utils/logger.js";
import { loadPromptTemplate } from "../utils/prompts.js";
import { invokeChatCompletion } from "./client.js";
import { FACT_SCHEMA } from "./extractor.js";
import {
  formatBaseCard,
  formatFactsForPrompt,
  formatPolicyRules,
  formatRunMetadata
} from "./formatters.js";
import type { PassContext, ExtractorResult, ReasonerResult } from "./types.js";

const REASONER_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    facts: FACT_SCHEMA.properties.facts
  },
  required: ["reasoning", "facts"],
  additionalProperties: false
};

interface ReasonerArtifact {
  promptId: string;
  promptMetadata: Record<string, unknown>;
  promptDigest: string;
  mode: string;
  facts: ReasonerResult["facts"];
  coverageNonNull: number;
  lowConfidence: ReasonerResult["lowConfidence"];
  extractorArtifact: string;
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
    metrics: ReasonerResult["metrics"];
  };
}

interface ReasonerPayload {
  reasoning?: string;
  facts?: Partial<Fact>[];
  lowConfidence?: Array<{ jsonPath: string; reason: string }>;
}

export async function runReasonerPass(
  context: PassContext,
  extractor: ExtractorResult
): Promise<ReasonerResult> {
  const prompt = await loadPromptTemplate("reasoner.v1.md");
  const deterministic = runDeterministicPipeline({
    baselineCard: context.baselineCard,
    changedFiles: context.analysis.changedFiles,
    insights: context.analysis.repository
  });

  const minConfidence = context.runtime.sampling.retryPolicy.minConfidence;
  const basePrompt = renderReasonerPrompt(context, extractor.facts, prompt.body, minConfidence);
  const fallbackResponse = JSON.stringify({
    facts: extractor.facts,
    lowConfidence: deterministic.lowConfidence
  });

  const maxAttempts = Math.max(1, context.runtime.sampling.retryPolicy.maxAttempts);
  let attemptsUsed = 0;
  let retryReasons: string[] = [];
  let promptAugmentation = "";
  let lastPromptBody = basePrompt;

  let mode: "deterministic" | "llm" = "deterministic";
  let llmTrace: ReasonerResult["llm"] = null;
  let metrics = { promptTokens: 0, completionTokens: 0, latencyMs: 0 };
  let llmContent = fallbackResponse;

  let mergedFacts = extractor.facts;
  let mutatedCard = applyFactsToCard(context.baselineCard, mergedFacts);
  let coverageNonNull = computeCoverage(mergedFacts);
  let lowConfidence = deterministic.lowConfidence;

  // Initial cool-down to allow token bucket to refill after Extractor pass
  await new Promise(resolve => setTimeout(resolve, 60000));

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
          temperature: context.runtime.sampling.reasoner.temperature,
          topP: context.runtime.sampling.reasoner.topP,
          maxTokens: context.runtime.sampling.reasoner.maxTokens,
          reasoningEffort: context.runtime.sampling.reasoner.reasoningEffort,
          verbosity: context.runtime.sampling.reasoner.verbosity,
          messages: [
            {
              role: "system",
              content: (prompt.metadata.system as string) ?? "You verify ML System Card facts."
            },
            { role: "user", content: lastPromptBody }
          ],
          fallbackResponse,
          jsonMode: true
        });
      } catch (primaryError) {
        const currentEffort = context.runtime.sampling.reasoner.reasoningEffort;
        const effortStr = String(currentEffort);

        if (effortStr === "high" || effortStr === "medium") {
          const newEffort = effortStr === "high" ? "medium" : "low";
          logger.warn(`Reasoner LLM failed with ${currentEffort} reasoning; downgrading to ${newEffort}`, {
            error: primaryError instanceof Error ? primaryError.message : String(primaryError)
          });
          result = await invokeChatCompletion(context.runtime, {
            promptId: prompt.id,
            temperature: context.runtime.sampling.reasoner.temperature,
            topP: context.runtime.sampling.reasoner.topP,
            maxTokens: context.runtime.sampling.reasoner.maxTokens,
            reasoningEffort: newEffort as "medium" | "low",
            verbosity: context.runtime.sampling.reasoner.verbosity,
            messages: [
              {
                role: "system",
                content: (prompt.metadata.system as string) ?? "You verify ML System Card facts."
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

      llmContent = result.content;
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
      logger.warn("Reasoner LLM invocation failed; using deterministic fallback", {
        runId: context.runId,
        attempt,
        error: error instanceof Error ? error.message : String(error)
      });
      mode = "deterministic";
      llmTrace = null;
      llmContent = fallbackResponse;
    }

    const payload = parseReasonerResponse(llmContent);
    mergedFacts = reconcileFacts(extractor.facts, payload.facts ?? [], context.analysis.metadata.headSha);
    mutatedCard = applyFactsToCard(context.baselineCard, mergedFacts);
    coverageNonNull = computeCoverage(mergedFacts);
    lowConfidence = (payload.lowConfidence ?? collectLowConfidence(mergedFacts)).map(item => ({
      jsonPath: item.jsonPath,
      reason: item.reason || "low confidence"
    }));

    retryReasons = collectReasonerRetryReasons(mergedFacts, lowConfidence, minConfidence);

    const shouldRetry =
      retryReasons.length > 0 &&
      attempt < maxAttempts &&
      mode === "llm";

    if (!shouldRetry) {
      break;
    }

    promptAugmentation = buildReasonerRetryGuidance(retryReasons);
  }

  const artifactPromptDigest = createHash("sha256").update(lastPromptBody).digest("hex");

  const artifact: ReasonerArtifact = {
    promptId: prompt.id,
    promptMetadata: prompt.metadata,
    promptDigest: artifactPromptDigest,
    mode,
    facts: mergedFacts,
    coverageNonNull,
    lowConfidence,
    extractorArtifact: extractor.artifactPath,
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
      artifact.llm.contentPreview = llmContent.slice(0, 2000);
    }
  }

  await fsExtra.ensureDir(PROPOSALS_DIR);
  const artifactPath = join(PROPOSALS_DIR, `${context.runId}${REASONER_ARTIFACT_SUFFIX}`);
  await writeJsonFile(artifactPath, artifact);
  const artifactDigest = createHash("sha256").update(JSON.stringify(artifact)).digest("hex");

  logger.info("Reasoner pass recorded", {
    runId: context.runId,
    mode,
    artifact: artifactPath,
    facts: mergedFacts.length,
    attempts: attemptsUsed,
    remainingLowConfidence: retryReasons.length
  });

  return {
    artifactPath,
    artifactDigest,
    promptId: prompt.id,
    mode,
    facts: mergedFacts,
    mutatedCard,
    coverageNonNull,
    lowConfidence,
    metrics,
    llm: llmTrace,
    attempts: attemptsUsed,
    retryReasons
  };
}

function renderReasonerPrompt(
  context: PassContext,
  candidateFacts: Fact[],
  template: string,
  minConfidence: number
): string {
  const replacements = new Map<string, string>([
    ["{RUN_METADATA}", formatRunMetadata(context)],
    ["{BASE_CARD}", formatBaseCard(context.baselineCard)],
    ["{CANDIDATE_FACTS}", formatFactsForPrompt(candidateFacts)],
    ["{POLICY_RULES}", formatPolicyRules(minConfidence)],
    ["{MIN_CONFIDENCE}", minConfidence.toFixed(2)]
  ]);
  let rendered = template;
  for (const [placeholder, value] of replacements.entries()) {
    rendered = rendered.replaceAll(placeholder, value);
  }
  return rendered;
}

function parseReasonerResponse(raw: string): ReasonerPayload {
  const cleaned = stripCodeFences(raw.trim());
  if (!cleaned) {
    return {};
  }
  try {
    const parsed = JSON.parse(cleaned) as ReasonerPayload;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return {};
  } catch (error) {
    logger.warn("Reasoner response was not valid JSON", {
      error: error instanceof Error ? error.message : String(error),
      snippet: cleaned.slice(0, 200)
    });
    return {};
  }
}

function reconcileFacts(baseFacts: Fact[], patches: Partial<Fact>[], headSha: string): Fact[] {
  const map = new Map<string, Fact>();
  const SHA_REGEX = /^[0-9a-fA-F]{7,40}$/;
  const VALID_KINDS = ["code", "openapi", "metrics", "docs", "config", "test"];

  baseFacts.forEach((fact) => map.set(fact.jsonPath, { ...fact, repoSources: fact.repoSources.map((anchor) => ({ ...anchor })) }));

  for (const patch of patches) {
    if (!patch.jsonPath) {
      continue;
    }
    const existing = map.get(patch.jsonPath);
    if (!existing) {
      continue;
    }

    let newAnchors = existing.repoSources;
    if (Array.isArray(patch.repoSources) && patch.repoSources.length > 0) {
      newAnchors = patch.repoSources.map((anchor) => {
        let commit = anchor?.commit ?? existing.repoSources[0]?.commit ?? headSha;
        if (!SHA_REGEX.test(commit)) {
          commit = headSha;
        }

        let kind = (anchor?.kind ?? existing.repoSources[0]?.kind) as any;
        if (!VALID_KINDS.includes(kind)) {
           if (anchor?.path?.endsWith(".md")) kind = "docs";
           else if (anchor?.path?.endsWith(".json") || anchor?.path?.endsWith(".yaml")) kind = "config";
           else kind = "code";
        }

        return {
          path: anchor?.path ?? existing.repoSources[0]?.path ?? "",
          startLine: anchor?.startLine ?? existing.repoSources[0]?.startLine ?? 1,
          endLine: anchor?.endLine ?? existing.repoSources[0]?.endLine ?? 1,
          commit,
          kind
        };
      });
    }

    map.set(patch.jsonPath, {
      ...existing,
      jsonPointer: patch.jsonPointer ?? existing.jsonPointer,
      proposedValue: patch.proposedValue ?? existing.proposedValue,
      repoSources: newAnchors,
      confidence: typeof patch.confidence === "number" ? patch.confidence : existing.confidence,
      gate: patch.gate ?? existing.gate,
      verifierNotes: patch.verifierNotes ?? existing.verifierNotes
    });
  }

  return Array.from(map.values()).sort((a, b) => a.jsonPath.localeCompare(b.jsonPath));
}

function applyFactsToCard<T>(baseline: T, facts: Fact[]): T {
  const clone: any = structuredCloneSafe(baseline);
  for (const fact of facts) {
    if (!fact.jsonPointer) {
      continue;
    }
    try {
      setValueAtPointer(clone, fact.jsonPointer, fact.proposedValue);
    } catch (error) {
      logger.warn("Failed to apply fact to card", {
        jsonPath: fact.jsonPath,
        pointer: fact.jsonPointer,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return clone as T;
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function setValueAtPointer(target: any, pointer: string, value: unknown): void {
  const tokens = pointer
    .split("/")
    .slice(1)
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current = target;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const isLast = index === tokens.length - 1;
    if (isLast) {
      current[token] = value;
      break;
    }
    if (!(token in current) || current[token] === null) {
      const nextToken = tokens[index + 1];
      current[token] = Number.isInteger(Number(nextToken)) ? [] : {};
    }
    current = current[token];
  }
}

function computeCoverage(facts: Fact[]): number {
  if (facts.length === 0) {
    return 0;
  }
  const anchored = facts.filter((fact) => fact.repoSources.length > 0).length;
  return anchored / facts.length;
}

function collectLowConfidence(facts: Fact[]): Array<{ jsonPath: string; reason: string }> {
  return facts
    .filter((fact) => fact.gate !== "OK")
    .map((fact) => ({ jsonPath: fact.jsonPath, reason: fact.verifierNotes || "low confidence" }));
}

function collectReasonerRetryReasons(
  facts: Fact[],
  lowConfidence: Array<{ jsonPath: string; reason: string }>,
  minConfidence: number
): string[] {
  const reasons = new Set<string>();

  lowConfidence.forEach((entry) => {
    reasons.add(`Low confidence for ${entry.jsonPath}: ${entry.reason}`);
  });

  facts.forEach((fact) => {
    if (typeof fact.confidence === "number" && fact.confidence < minConfidence) {
      reasons.add(
        `Confidence ${fact.confidence.toFixed(2)} below minimum ${minConfidence.toFixed(2)} for ${fact.jsonPath}`
      );
    }
    if (fact.repoSources.length === 0) {
      reasons.add(`Missing repository evidence for ${fact.jsonPath}`);
    }
    if (fact.gate && fact.gate !== "OK") {
      reasons.add(`Fact ${fact.jsonPath} gated as ${fact.gate}`);
    }
  });

  return Array.from(reasons);
}

function buildReasonerRetryGuidance(retryReasons: string[]): string {
  if (retryReasons.length === 0) {
    return "";
  }
  const bulletList = retryReasons.map((reason, index) => `${index + 1}. ${reason}`).join("\n");
  return `Please resolve all outstanding issues before responding again:\n${bulletList}\n\nReturn a complete JSON response that addresses every item.`;
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
