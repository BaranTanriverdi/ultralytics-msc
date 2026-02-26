export interface RepoSearchRequest {
  query: string;
  maxHits?: number;
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

export interface RepoSearchHit {
  file: string;
  line: number;
  text: string;
  context?: string[];
}

export interface RepoSearchResponse {
  hits: RepoSearchHit[];
  truncated: boolean;
}

export interface AstSummaryRequest {
  file: string;
}

export interface AstNodeSummary {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature?: string;
}

export interface AstSummaryResponse {
  file: string;
  nodes: AstNodeSummary[];
}

export interface ToolInvocationMetrics {
  elapsedMs: number;
  tokensPrompt: number;
  tokensCompletion: number;
}

export interface ToolTrace<TResponse> {
  request: unknown;
  response: TResponse;
  metrics: ToolInvocationMetrics;
}
