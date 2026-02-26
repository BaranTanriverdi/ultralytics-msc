import type { Fact, Proposal } from "lib/card/types.js";

import type { CardSeed } from "../card/seed.js";
import type { AnalysisBundle } from "../analysis/bundle.js";
import type { LlmRuntimeConfig } from "../config/env.js";

export interface PassContext {
  runId: string;
  baselineCard: CardSeed;
  analysis: AnalysisBundle;
  runtime: LlmRuntimeConfig;
}

export interface PassMetrics {
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface LlmTraceSummary {
  provider: string | null;
  model: string | null;
  requestDigest: string | null;
  responseDigest: string | null;
}

export interface PassResultBase {
  artifactPath: string;
  artifactDigest: string;
  promptId: string;
  mode: string;
  metrics: PassMetrics;
  llm: LlmTraceSummary | null;
  attempts: number;
  retryReasons: string[];
}

export interface ExtractorResult extends PassResultBase {
  facts: Fact[];
}

export interface ReasonerResult extends PassResultBase {
  facts: Fact[];
  mutatedCard: CardSeed;
  coverageNonNull: number;
  lowConfidence: Array<{ jsonPath: string; reason: string }>;
}

export interface VerifierResult extends PassResultBase {
  facts: Fact[];
  verifications: Array<{
    jsonPath: string;
    valid: boolean;
    comment: string;
    adjustedConfidence?: number;
  }>;
}

export interface NotesResult extends PassResultBase {
  notes: Proposal["notes"];
}
