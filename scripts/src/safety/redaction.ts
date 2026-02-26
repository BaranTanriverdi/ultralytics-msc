const SECRET_PATTERNS: Array<RegExp> = [
  /\b(?![0-9a-f]{40}\b)[A-Za-z0-9]{32,}\b/g, // generic API keys / tokens (skip git SHA-1 hashes)
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bghp_[A-Za-z0-9]{30,64}\b/g, // GitHub personal access token (variable length)
  /\b(?![0-9a-f]{40}\b)[A-Za-z0-9+]{40,}=*/g // base64-like secrets (skip git SHA-1 hashes; excludes '/' to avoid matching paths)
];

const FILE_DENYLIST = [/\.env/i, /secrets/i, /config\.(json|yaml|yml)/i];

export interface RedactionResult {
  content: string;
  redactions: number;
}

export function redactSecrets(content: string): RedactionResult {
  let redactions = 0;
  let sanitized = content;
  for (const pattern of SECRET_PATTERNS) {
  sanitized = sanitized.replace(pattern, (_match) => {
      redactions += 1;
      return "<redacted>";
    });
  }
  return { content: sanitized, redactions };
}

export function isPathDenied(path: string): boolean {
  return FILE_DENYLIST.some((pattern) => pattern.test(path));
}

/**
 * Paths belonging to the MSC (ML System Card) generator infrastructure.
 * These must never be analysed as project source code because they would
 * pollute the card content with references to the tooling itself.
 *
 * IMPORTANT: Only list paths that are **unambiguously** part of the MSC
 * pipeline.  Actual project code (src/, notebooks/, tests/, lib/<project>/,
 * docs/stakeholders.yaml, …) must NOT appear here.
 */
const MSC_INFRA_PATTERNS: RegExp[] = [
  /^scripts\//,                              // MSC pipeline source & config
  /^lib\/card\//,                            // MSC card TS library
  /^lib\/[^/]+\.schema\.json$/,              // MSC JSON-Schema definitions
  /^lib\/tsconfig\.base\.json$/,             // MSC shared tsconfig
  /^\.github\/workflows\/generator\.yml$/,   // MSC generator workflow
  /^\.github\/workflows\/apply\.yml$/,       // MSC apply workflow
  /^\.github\/workflows\/ci\.yml$/,          // MSC CI workflow
  /^docs\/prototype_card\.[\w]+$/,            // MSC card config & anchor files
  /^\.msc\//,                                // MSC working directory
];

export function isMscInfrastructure(path: string): boolean {
  return MSC_INFRA_PATTERNS.some((pattern) => pattern.test(path));
}
