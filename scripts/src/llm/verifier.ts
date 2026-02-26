import { join } from "node:path";
import { createHash } from "node:crypto";

import { summarizeNotebook } from "../analysis/bundle.js";
import type { Fact, Anchor } from "lib/card/types.js";
import { readTextFile } from "../utils/fs.js";
import { logger } from "../utils/logger.js";
import { loadPromptTemplate } from "../utils/prompts.js";
import { invokeChatCompletion } from "./client.js";
import { formatRunMetadata } from "./formatters.js";
import type { PassContext, ReasonerResult, VerifierResult } from "./types.js";

const VERIFIER_SCHEMA = {
  type: "object",
  properties: {
    verifications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          jsonPath: { type: "string" },
          valid: { type: "boolean" },
          comment: { type: "string" },
          adjustedConfidence: { type: ["number", "null"] }
        },
        required: ["jsonPath", "valid", "comment", "adjustedConfidence"],
        additionalProperties: false
      }
    }
  },
  required: ["verifications"],
  additionalProperties: false
};

function estimateTokens(text: string): number {
  // More conservative estimate for code-heavy content
  return Math.ceil(text.length / 2.5);
}

interface VerificationItem {
  jsonPath: string;
  valid: boolean;
  comment: string;
  adjustedConfidence?: number;
}

export async function runVerifierPass(
  context: PassContext,
  reasonerResult: ReasonerResult
): Promise<VerifierResult> {
  const prompt = await loadPromptTemplate("verifier.v1.md");

    // 1. Prepare Facts and Snippets
  const factsToVerify = reasonerResult.facts.filter(f => f.repoSources && f.repoSources.length > 0);

  if (factsToVerify.length === 0) {
    logger.info("No facts with anchors to verify; skipping verifier pass.");
    return createNoOpResult(reasonerResult);
  }

  const snippets = await collectSnippets(factsToVerify);

  // 2. Pre-validate facts with missing snippets to save tokens
  const factsWithSnippets: Fact[] = [];
  const preInvalidatedVerifications: VerificationItem[] = [];
  const MAX_ANCHORS_PER_FACT = 3; // Cap anchors to prevent massive payloads

  for (const fact of factsToVerify) {
    // Filter for valid anchors first
    const validAnchors = fact.repoSources.filter(a => {
      const id = getAnchorId(a);
      return snippets[id] && snippets[id] !== "(Snippet unavailable)";
    });

    if (validAnchors.length > 0) {
      // If too many anchors, take the top N to save tokens
      if (validAnchors.length > MAX_ANCHORS_PER_FACT) {
        // We modify the fact copy to only include the subset of anchors for verification
        const truncatedFact = { ...fact, repoSources: validAnchors.slice(0, MAX_ANCHORS_PER_FACT) };
        factsWithSnippets.push(truncatedFact);
      } else {
        factsWithSnippets.push(fact);
      }
    } else {
      preInvalidatedVerifications.push({
        jsonPath: fact.jsonPath,
        valid: false,
        comment: "Source snippet unavailable or file not found.",
        adjustedConfidence: 0.5
      });
    }
  }

  // Prepare facts without embedded snippets to save tokens
  const factsPayload = factsWithSnippets.map(f => ({
    jsonPath: f.jsonPath,
    value: f.proposedValue,
    anchors: f.repoSources.map(a => ({
      path: a.path,
      lines: `${a.startLine}-${a.endLine}`,
      anchorId: getAnchorId(a) // Reference the snippet by ID
    }))
  }));

  const meta = prompt.metadata as {
    id: string;
    max_tokens: number;
    sampling: { temperature: number; top_p: number };
  };

  let allVerifications: VerificationItem[] = [...preInvalidatedVerifications];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalLatencyMs = 0;
  let lastResponse = null;

  // Smart Batching: Group by token count to avoid TPM limits
  const TARGET_TPM = 20000; // Target 20k TPM (limit is 30k)
  const MAX_BATCH_TOKENS = 5000; // Increased slightly as we have dynamic throttling
  const batches: { facts: typeof factsPayload, snippets: Record<string, string> }[] = [];

  let currentBatchFacts: typeof factsPayload = [];
  let currentBatchSnippets: Record<string, string> = {};
  let currentTokens = 0;

  for (const item of factsPayload) {
    // Calculate tokens for this fact + any NEW snippets it introduces
    let itemTokens = estimateTokens(JSON.stringify(item));
    const newSnippets: Record<string, string> = {};

    for (const anchor of item.anchors) {
      if (!currentBatchSnippets[anchor.anchorId]) {
        const snippetContent = snippets[anchor.anchorId] ?? "(Snippet unavailable)";
        // If snippet is unavailable, we can skip sending it to LLM and handle it locally
        // But for now, let's keep it simple and let LLM reject it, or we can pre-filter.
        // Actually, let's pre-filter in the next step.
        newSnippets[anchor.anchorId] = snippetContent;
        itemTokens += estimateTokens(snippetContent);
      }
    }

    // If adding this item exceeds limit, push current batch
    if (currentTokens + itemTokens > MAX_BATCH_TOKENS && currentBatchFacts.length > 0) {
      batches.push({ facts: currentBatchFacts, snippets: currentBatchSnippets });
      currentBatchFacts = [];
      currentBatchSnippets = {};
      currentTokens = 0;
    }

    // If a single item is larger than MAX_BATCH_TOKENS, we must still process it.
    // We'll put it in its own batch, even if it exceeds the limit, and rely on throttling to handle it.
    // The throttling logic uses the ACTUAL token count of the batch, so it will just wait longer.
    currentBatchFacts.push(item);
    Object.assign(currentBatchSnippets, newSnippets);
    currentTokens += itemTokens;
  }

  if (currentBatchFacts.length > 0) {
    batches.push({ facts: currentBatchFacts, snippets: currentBatchSnippets });
  }

  logger.info(`Verifier prepared ${batches.length} batches for ${factsPayload.length} facts.`);

  // Initial cool-down to allow token bucket to refill after Reasoner pass
  // Increased to 60s to ensure bucket is ready
  await new Promise(resolve => setTimeout(resolve, 60000));

  for (let i = 0; i < batches.length; i++) {
    const chunk = batches[i];
    const estimatedTokens = estimateTokens(JSON.stringify(chunk));

    // Dynamic Delay based on Token Usage
    if (i > 0) {
      // Calculate delay needed to replenish tokens at TARGET_TPM rate
      // Formula: (Tokens / TPM) * 60 * 1000 ms
      const delayMs = Math.ceil((estimatedTokens / TARGET_TPM) * 60 * 1000);
      logger.info(`Throttling for ${delayMs}ms to respect ${TARGET_TPM} TPM...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    const promptBody = prompt.body
      .replace("{RUN_METADATA}", formatRunMetadata(context))
      .replace("{FACTS_TO_VERIFY}", JSON.stringify(chunk)); // Compact JSON to save tokens


    const response = await invokeChatCompletion(context.runtime, {
      promptId: meta.id,
      temperature: meta.sampling.temperature,
      topP: meta.sampling.top_p,
      maxTokens: meta.max_tokens,
      reasoningEffort: context.runtime.sampling.verifier.reasoningEffort,
      verbosity: context.runtime.sampling.verifier.verbosity,
      messages: [
        { role: "system", content: promptBody }
      ],
      jsonSchema: VERIFIER_SCHEMA,
      fallbackResponse: JSON.stringify({ verifications: [] })
    });

    lastResponse = response;
    totalPromptTokens += response.promptTokens;
    totalCompletionTokens += response.completionTokens;
    totalLatencyMs += response.latencyMs;

    try {
      const parsed = JSON.parse(response.content);
      if (parsed && Array.isArray(parsed.verifications)) {
        allVerifications.push(...parsed.verifications);
      }
    } catch (err) {
      logger.warn("Failed to parse verifier response", { error: err });
    }
  }

  // 5. Apply Verifications
  const verifiedFacts = reasonerResult.facts.map(fact => {
    const verification = allVerifications.find(v => v.jsonPath === fact.jsonPath);
    if (!verification) {
      // If we expected a verification (has sources) but didn't get one, log a warning
      if (fact.repoSources && fact.repoSources.length > 0) {
        logger.warn(`Verifier result missing for fact: ${fact.jsonPath}. Keeping original.`);
      }
      return fact;
    }

    const clone = { ...fact };

    if (verification.adjustedConfidence !== undefined && verification.adjustedConfidence !== null) {
      // Only allow downgrading
      if (verification.adjustedConfidence < clone.confidence) {
        clone.confidence = verification.adjustedConfidence;
      }
    }

    // Heuristic: If comment explicitly marks it as invalid, trust the comment over a "true" boolean.
    // This catches "Zombie Facts" where LLM says valid: true but writes "This is incorrect".
    // We check for specific keywords at the START of the comment or contained within.
    const isCommentInvalid = /\b(invalid|incorrect|hallucination|wrong)\b/i.test(verification.comment);
    // Also force invalid if confidence is extremely low (below 0.2) after adjustment
    const isLowConfidence = clone.confidence < 0.2;

    // Effective validity
    // For inferred facts, we are more lenient. If the Extractor inferred it from high-level patterns (like filenames),
    // the snippet (lines 1-50) might not explicitly prove it, leading the Verifier to reject it.
    // We trust the Extractor's inference for these high-level architectural claims unless the Verifier explicitly calls it a "hallucination".
    const isInferred = fact.source?.kind === 'inferred';
    const isValid = (verification.valid || (isInferred && !isCommentInvalid))
                    && !isCommentInvalid
                    && !isLowConfidence;

    if (!isValid) {
      clone.gate = "Warn"; // Downgrade to Warn
      clone.verifierNotes = verification.comment;
      // If confidence drops below threshold, it might become Require, but let's stick to Warn for invalid anchors
      // unless confidence is also very low.
      if (clone.confidence < context.runtime.sampling.retryPolicy.minConfidence) {
        clone.gate = "Require";
      }
    }

    return clone;
  });

  return {
    artifactPath: "memory", // or save if needed
    artifactDigest: createHash("sha256").update(JSON.stringify(verifiedFacts)).digest("hex"),
    promptId: meta.id,
    mode: lastResponse?.mode ?? "llm",
    metrics: {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      latencyMs: totalLatencyMs
    },
    llm: {
      provider: context.runtime.provider,
      model: context.runtime.model,
      requestDigest: lastResponse?.requestDigest ?? "",
      responseDigest: lastResponse?.responseDigest ?? ""
    },
    attempts: 1,
    retryReasons: [],
    facts: verifiedFacts,
    verifications: allVerifications
  };
}

async function collectSnippets(facts: Fact[]): Promise<Record<string, string>> {
  const snippets: Record<string, string> = {};
  const fileCache: Record<string, string[]> = {};
  const MAX_SNIPPET_LINES = 50; // Cap snippet size to prevent token explosion

  for (const fact of facts) {
    for (const anchor of fact.repoSources) {
      const id = getAnchorId(anchor);
      if (snippets[id]) continue;

      if (!fileCache[anchor.path]) {
        const content = await readTextFile(anchor.path);
        if (content) {
          if (anchor.path.endsWith(".ipynb")) {
            fileCache[anchor.path] = summarizeNotebook(content).preview;
          } else {
            fileCache[anchor.path] = content.split("\n");
          }
        } else {
          fileCache[anchor.path] = [];
        }
      }

      const lines = fileCache[anchor.path];
      if (lines.length > 0) {
        // 1-based index to 0-based
        const start = Math.max(0, anchor.startLine - 1);
        let end = Math.min(lines.length, anchor.endLine);

        // Enforce max lines
        if (end - start > MAX_SNIPPET_LINES) {
          end = start + MAX_SNIPPET_LINES;
          const snippet = lines.slice(start, end).join("\n") + "\n... (truncated)";
          snippets[id] = snippet;
        } else {
          snippets[id] = lines.slice(start, end).join("\n");
        }
      }
    }
  }
  return snippets;
}

function getAnchorId(anchor: Anchor): string {
  return `${anchor.path}:${anchor.startLine}-${anchor.endLine}`;
}

function createNoOpResult(reasonerResult: ReasonerResult): VerifierResult {
  return {
    ...reasonerResult,
    verifications: [],
    metrics: { promptTokens: 0, completionTokens: 0, latencyMs: 0 },
    llm: null,
    attempts: 0,
    retryReasons: []
  };
}
