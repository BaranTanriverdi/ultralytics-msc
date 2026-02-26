import { join } from "node:path";

const PROPOSALS_OVERRIDE = process.env.ML_SYSTEM_CARD_PROPOSALS_DIR;
const ANALYSIS_OVERRIDE = process.env.ML_SYSTEM_CARD_ANALYSIS_DIR;
const ANALYSIS_CACHE_OVERRIDE = process.env.ML_SYSTEM_CARD_ANALYSIS_CACHE_PATH;

export const CARD_PATH = "docs/ml_system_card.yaml";
export const ANCHORS_PATH = "docs/ml_system_card.anchors.json";
export const PROPOSALS_DIR = PROPOSALS_OVERRIDE ?? "docs/.proposals";
export const DECISIONS_SUFFIX = ".decisions.json";
export const MICRO_RECEIPTS_DIR = "docs/.card_runs";
export const SCHEMA_PATH = "lib/ml_system_card.schema.json";
export const ANCHORS_SCHEMA = "https://example.com/ml_system_card.anchors.schema.json";
export const DEFAULT_ANCHORS_VERSION = "1.0.0";
export const COVERAGE_THRESHOLD = 0.80;
export const ALLOWED_PATH_PREFIXES = ["docs/", "lib/"];
export const DATE_FORMAT = "YYYY-MM-DD";
export const MAX_DIFF_LINES = 500;
export const MAX_CARD_GROWTH_RATIO = 3;

export const ANALYSIS_DIR = ANALYSIS_OVERRIDE ?? "docs/.analysis";
export const ANALYSIS_CACHE_PATH = ANALYSIS_CACHE_OVERRIDE ?? join(ANALYSIS_DIR, "cache.json");
export const EXTRACTOR_ARTIFACT_SUFFIX = ".extractor.json";
export const REASONER_ARTIFACT_SUFFIX = ".reasoner.json";
export const NOTES_ARTIFACT_SUFFIX = ".notes.json";

export const LLM_ENV_VARIABLES = {
	apiKey: "LLM_API_KEY",
	baseUrl: "LLM_BASE_URL",
	provider: "LLM_PROVIDER",
	model: "LLM_MODEL",
	enabled: "LLM_ENABLED",
	dryRun: "LLM_DRY_RUN",
	privacyMode: "LLM_PRIVACY_MODE"
} as const;

// GPT-5.1 Specs: 400k nominal context, 272k API-configured limit, 128k output
// Evidence budget is now computed dynamically in formatters.ts:computeEvidenceTokenBudget()
export const DEFAULT_LLM_SETTINGS = {
	extractor: {
		temperature: 0.1,
		topP: 0.95,
		maxTokens: 100000,
		reasoningEffort: "medium",
		verbosity: "medium"
	},
	reasoner: {
		temperature: 0,
		topP: 0.9,
		maxTokens: 128000,
		reasoningEffort: "medium",
		verbosity: "medium"
	},
	verifier: {
		temperature: 0,
		topP: 0.9,
		maxTokens: 32000,
		reasoningEffort: "low",
		verbosity: "low"
	},
	notes: {
		temperature: 0.25,
		topP: 0.85,
		maxTokens: 16384,
		reasoningEffort: "low",
		verbosity: "medium"
	},

	retryPolicy: {
		maxAttempts: 1,
		minConfidence: 0.65
	}
} as const;

export const DEFAULT_RATE_LIMITS = {
	maxParallel: 2,
	baseDelayMs: 250,
	jitterMs: 100
} as const;

export const FEATURE_FLAGS = {
	llmEnabled: "LLM_ENABLED",
	llmDryRun: "LLM_DRY_RUN"
} as const;

export const SAFETY_LIMITS = {
	maxFacts: 1000,
	maxNotes: 25
} as const;
