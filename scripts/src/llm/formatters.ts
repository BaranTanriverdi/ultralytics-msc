import { dump } from "js-yaml";
import { extname } from "node:path";

import type { Fact } from "lib/card/types.js";
import { getPythonSkeleton } from "../analysis/ast.js";

import type { AnalysisBundle, FileEvidence } from "../analysis/bundle.js";
import type { RepositoryStaticSignals } from "../analysis/signals.js";
import { estimateTokens } from "./client.js";
import type { PassContext } from "./types.js";

/**
 * Default fallback evidence token budget (150 000).
 * Callers should compute a dynamic budget from the model's actual context
 * window via {@link computeEvidenceTokenBudget} and pass it explicitly.
 */
const DEFAULT_EVIDENCE_TOKENS = 150000;

export function formatRunMetadata(context: PassContext): string {
  const { analysis, runId } = context;
  const lines = [
    `Run ID: ${runId}`,
    `Base SHA: ${analysis.metadata.baseSha}`,
    `Head SHA: ${analysis.metadata.headSha}`,
    `Changed files (${analysis.changedFiles.length}): ${analysis.changedFiles.join(", ") || "none"}`,
    `Generated at: ${analysis.metadata.generatedAt}`
  ];
  return lines.join("\n");
}

export function formatBaseCard(card: unknown): string {
  return dump(card, { lineWidth: 120 });
}

export async function formatEvidenceForPrompt(
  bundle: AnalysisBundle,
  maxTokens: number = DEFAULT_EVIDENCE_TOKENS
): Promise<string> {
  if (bundle.fileEvidence.length === 0) {
    return "No changed files detected. Fact extraction should focus on repository-wide signals.";
  }

  const signalsSegment = formatStaticSignals(bundle.staticSignals);
  const signalsTokens = estimateTokens(signalsSegment);
  let remainingTokens = maxTokens - signalsTokens;

  // Prioritize files:
  // 1. Critical files (README, package.json, etc.)
  // 2. Changed files
  // 3. Others
  const CRITICAL_FILES = [
    "README.md",
    "package.json",
    "go.mod",
    "Cargo.toml",
    "pom.xml",
    "requirements.txt",
    "environment.yaml",
    "setup.cfg",
    "setup.py",
    "pyproject.toml"
  ];

  const sortedEvidence = [...bundle.fileEvidence].sort((a, b) => {
    const aIsCritical = CRITICAL_FILES.some(f => a.path.endsWith(f));
    const bIsCritical = CRITICAL_FILES.some(f => b.path.endsWith(f));
    if (aIsCritical && !bIsCritical) return -1;
    if (!aIsCritical && bIsCritical) return 1;

    // Prioritize notebooks and source code for ML context
    const aIsSource = a.path.endsWith(".ipynb") || a.path.endsWith(".py");
    const bIsSource = b.path.endsWith(".ipynb") || b.path.endsWith(".py");
    if (aIsSource && !bIsSource) return -1;
    if (!aIsSource && bIsSource) return 1;

    const aIsChanged = bundle.changedFiles.includes(a.path);
    const bIsChanged = bundle.changedFiles.includes(b.path);
    if (aIsChanged && !bIsChanged) return -1;
    if (!aIsChanged && bIsChanged) return 1;
    return 0;
  });

  const segments: string[] = [];
  for (const entry of sortedEvidence) {
    if (remainingTokens <= 0) {
      segments.push(`Path: ${entry.path} (skipped due to token limit)`);
      continue;
    }

    const fullEntry = await formatEvidenceEntry(entry, true);
    const fullTokens = estimateTokens(fullEntry);

    if (fullTokens <= remainingTokens) {
      segments.push(fullEntry);
      remainingTokens -= fullTokens;
    } else {
      // Fallback to AST summary/skeleton
      const summaryEntry = await formatEvidenceEntry(entry, false);
      const summaryTokens = estimateTokens(summaryEntry);
      if (summaryTokens <= remainingTokens) {
        segments.push(summaryEntry);
        remainingTokens -= summaryTokens;
      } else {
        segments.push(`Path: ${entry.path} (skipped due to token limit)`);
      }
    }
  }

  return [segments.join("\n\n"), signalsSegment].filter(Boolean).join("\n\n");
}

async function formatEvidenceEntry(entry: FileEvidence, includePreview: boolean): Promise<string> {
  let preview = "<preview omitted>";

  if (includePreview) {
      preview = entry.preview.length > 0 ? entry.preview.join("\n") : "<preview omitted>";
  } else {
      // Context Optimization: AST-based skeleton for supported languages
      const ext = extname(entry.path);
      if (ext === ".py") {
          // Reconstruct content from lines to pass to parser
          // Note: entry.preview might be truncated lines?
          // Actually FileEvidence usually contains `content` or `preview` (lines).
          // Looking at types (which I haven't read fully), let's assume `preview` is good enough
          // OR we should have the full content if available.
          // If `preview` is already truncated, skeletonizing it is moot.
          // However, LLM pipeline usually loads full content into memory before creating evidence bundle?
          // Let's assume entry.preview is the content we have.
          const content = entry.preview.join("\n");
          preview = await getPythonSkeleton(content);
      }
  }

  const cacheLabel = entry.cacheHit ? "cached" : "fresh";
  const neighbors = entry.neighbors.length > 0 ? `Neighbors: ${entry.neighbors.slice(0, 6).join(", ")}` : "Neighbors: none";

  // Keep the old static AST summary if available
  const astSummary = entry.ast && entry.ast.nodes.length > 0
    ? `AST Structure: ${entry.ast.nodes
        .slice(0, 5)
        .map((node) => `${node.kind} ${node.name} [${node.startLine}-${node.endLine}]`)
        .join("; ")}`
    : ""; // Don't show "no structural summary" if we have skeleton? Or keep it.

  return [
    `Path: ${entry.path} (${cacheLabel}, bytes=${entry.size})`,
    `Content:\n${preview}`,
    neighbors,
    astSummary
  ].filter(Boolean).join("\n");
}

export function formatStaticSignals(signals: RepositoryStaticSignals): string {
  const blocks: string[] = [];
  if (signals.coverage.length > 0) {
    const coverageLines = signals.coverage
      .map((entry) => `- ${entry.type}: ${(entry.percentage * 100).toFixed(1)}% (${entry.source})`)
      .join("\n");
    blocks.push(`Coverage Signals:\n${coverageLines}`);
  }
  if (signals.openApiSpecs.length > 0) {
    const specLines = signals.openApiSpecs
      .map((spec) => `- ${spec.path}${spec.title ? ` (${spec.title}${spec.version ? ` v${spec.version}` : ""})` : ""}`)
      .join("\n");
    blocks.push(`OpenAPI Specs:\n${specLines}`);
  }
  if (signals.metrics.length > 0) {
    const metricLines = signals.metrics
      .slice(0, 10)
      .map((metric) => `- ${metric.name}: ${metric.value} (source: ${metric.source})`)
      .join("\n");
    blocks.push(`Operational Metrics:\n${metricLines}`);
  }
  return blocks.length > 0 ? blocks.join("\n\n") : "";
}

export function formatPolicyRules(minConfidence: number): string {
  return [
    "Policy rules for ML System Card facts:",
    "- Facts with confidence >= 0.80 are tagged OK.",
    "- Facts with confidence between 0.65 and 0.79 are tagged Warn and must be explicitly accepted or edited.",
    `- Facts with confidence < ${minConfidence.toFixed(2)} are tagged Require and must not pass without reviewer intervention.`,
    "- Every fact must include at least one repo anchor (filename + line range)."
  ].join("\n");
}

export function formatFactsForPrompt(facts: Fact[]): string {
  if (facts.length === 0) {
    return "[]";
  }
  return JSON.stringify(
    facts.map((fact) => ({
      jsonPath: fact.jsonPath,
      proposedValue: fact.proposedValue,
      confidence: fact.confidence,
      gate: fact.gate,
      repoSources: fact.repoSources,
      verifierNotes: fact.verifierNotes ?? null
    })),
    null,
    2
  );
}

export function summarizeFactsForStakeholder(facts: Fact[], stakeholderId: string): string {
  const relevant = facts.filter((fact) => fact.jsonPath.includes(stakeholderFocus(stakeholderId)));
  const collection = (relevant.length > 0 ? relevant : facts.slice(0, 5)).map((fact) => ({
    path: fact.jsonPath,
    confidence: fact.confidence,
    anchors: fact.repoSources.length
  }));
  return JSON.stringify(collection, null, 2);
}

function stakeholderFocus(stakeholderId: string): string {
  if (stakeholderId.includes("product")) {
    return "business";
  }
  if (stakeholderId.includes("governance")) {
    return "governance";
  }
  if (stakeholderId.includes("ml") || stakeholderId.includes("engineer")) {
    return "devInsight";
  }
  return "business";
}

// ---------------------------------------------------------------------------
// Dynamic token budget computation
// ---------------------------------------------------------------------------

/**
 * Known context window sizes for common models.
 * These can be overridden via the `LLM_CONTEXT_WINDOW` env variable.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5.1": 272000,      // API-reported configured limit (nominal 400 000)
  "gpt-4.1": 128000,
  "gpt-4o": 128000,
  "o1-preview": 128000,
  "o1-mini": 128000,
  "o1": 200000,
  "o3-mini": 200000
};

/** Tokens reserved for system prompt, base card YAML, run metadata, policy rules, and template chrome. */
const PROMPT_OVERHEAD_TOKENS = 10000;
/** Additional safety margin to avoid borderline overflows. */
const SAFETY_MARGIN_TOKENS = 5000;
/** Absolute minimum evidence budget – if the computed value falls below this, we still try. */
const MIN_EVIDENCE_TOKENS = 20000;

/**
 * Compute the maximum evidence token budget for a given model context window and
 * output-token reservation.
 *
 * Formula:  evidenceBudget = contextWindow − maxOutputTokens − overhead − safetyMargin
 *
 * The caller can override the context window via the `LLM_CONTEXT_WINDOW` env variable;
 * otherwise, we look up the model name in {@link MODEL_CONTEXT_WINDOWS} and fall back to
 * {@link DEFAULT_EVIDENCE_TOKENS}.
 */
export function computeEvidenceTokenBudget(
  model: string | null,
  maxOutputTokens: number
): number {
  const envOverride = process.env.LLM_CONTEXT_WINDOW;
  let contextWindow: number | null = null;

  if (envOverride && !Number.isNaN(Number(envOverride))) {
    contextWindow = Number(envOverride);
  } else if (model) {
    // Match the model string prefix (e.g. "gpt-5.1-0527" → "gpt-5.1")
    for (const [prefix, window] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
      if (model.startsWith(prefix)) {
        contextWindow = window;
        break;
      }
    }
  }

  if (contextWindow === null) {
    // No known context window – use the safe default
    return DEFAULT_EVIDENCE_TOKENS;
  }

  const budget = contextWindow - maxOutputTokens - PROMPT_OVERHEAD_TOKENS - SAFETY_MARGIN_TOKENS;
  return Math.max(MIN_EVIDENCE_TOKENS, budget);
}
