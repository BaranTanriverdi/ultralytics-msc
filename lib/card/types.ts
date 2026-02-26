export type JsonPath = string;

export type Gate = "OK" | "Warn" | "Require";

export interface Anchor {
  path: string;
  startLine: number;
  endLine: number;
  commit: string;
  fingerprint?: string;
  kind?: "code" | "openapi" | "metrics" | "docs" | "config" | "test";
}

export interface Fact {
  jsonPath: JsonPath;
  jsonPointer?: string;
  currentValue?: unknown;
  proposedValue: unknown;
  unit?: string;
  source: { kind: "extracted" | "inferred" | "manual" };
  repoSources: Anchor[];
  confidence: number;
  gate: Gate;
  verifierNotes?: string;
}

export interface ProposalMeta {
  runId: string;
  baseSha: string;
  schemaVersion: string;
  thresholds: {
    ok: number;
    warn: number;
  };
  provenance?: {
    promptId: string;
    model: string | null;
    toolCallHashes?: string[];
    generatedAt: string;
  };
  telemetry?: {
    latencyMs: number;
    tokens: {
      prompt: number;
      completion: number;
      total: number;
    };
    retries: number;
  };
  passTelemetry?: {
    extractor?: { latencyMs: number; promptTokens: number; completionTokens: number };
    reasoner?:  { latencyMs: number; promptTokens: number; completionTokens: number };
    verifier?:  { latencyMs: number; promptTokens: number; completionTokens: number };
    notes?:     { latencyMs: number; promptTokens: number; completionTokens: number };
  };
}

export type JsonPatchOperation =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown }
  | { op: "move"; from: string; path: string }
  | { op: "copy"; from: string; path: string }
  | { op: "test"; path: string; value: unknown };

export interface ConfidenceReportRow {
  jsonPath: JsonPath;
  kind: Fact["source"]["kind"];
  confidence: number;
  gate: Gate;
  sources: string[];
}

export interface Proposal {
  meta: ProposalMeta;
  facts: Fact[];
  patch: JsonPatchOperation[];
  card_patch?: JsonPatchOperation[];
  notes: Record<string, { textMd?: string; overview?: string; changes?: string; confidence: number }>;
  diagnostics: {
    coverage_non_null: number;
    low_confidence: Array<{ jsonPath: JsonPath; reason: string }>;
    warnings?: string[];
  };
  confidence_report: ConfidenceReportRow[];
  sources: string[];
}

export interface Decision {
  jsonPath: JsonPath;
  decision: "accept" | "reject" | "edit";
  editedValue?: unknown;
  anchors?: Anchor[];
  lock?: boolean;
  skipGeneration?: boolean;
}

export interface AnchorsIndex {
  $schema?: string;
  version: string;
  cardSha: string;
  runId: string;
  generatedAt: string;
  anchorsByPath: Record<JsonPath, Anchor[]>;
  unanchoredReasons?: Record<JsonPath, string>;
}

export interface MicroReceiptLowConfidenceRow {
  path: JsonPath;
  confidence: number;
  sources: string[];
  disposition: "accepted" | "edited" | "rejected";
}

export interface MicroReceipt {
  engine: string;
  run_id: string;
  base_sha: string;
  changed_paths: JsonPath[];
  low_confidence_rows_only: MicroReceiptLowConfidenceRow[];
  yaml_hash: string;
  schema_id: string;
  coverage_non_null: number;
  timestamp: string;
}

export interface CardWriteResult {
  newYaml: string;
  sha256: string;
}
