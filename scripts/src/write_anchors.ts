import type { Anchor, AnchorsIndex, Fact } from "lib/card/types.js";

import { DEFAULT_ANCHORS_VERSION, ANCHORS_SCHEMA } from "./constants.js";
import { normalizeAnchorsIndex } from "./card/deterministic.js";

const FORBIDDEN_PATTERNS = [/\.env/i, /secrets?\./i, /id_rsa/i];

export interface AnchorsBuildOptions {
  runId: string;
  cardSha: string;
  version?: string;
}

export function buildAnchorsIndex(facts: Fact[], options: AnchorsBuildOptions): AnchorsIndex {
  const anchorsByPath = new Map<string, Anchor[]>();
  const unanchoredReasons = new Map<string, string>();

  for (const fact of facts) {
    if (!fact.repoSources || fact.repoSources.length === 0) {
      if (fact.source.kind === "inferred" || fact.source.kind === "manual") {
        unanchoredReasons.set(fact.jsonPath, fact.source.kind);
      }
      continue;
    }
    const sanitized = fact.repoSources.filter((anchor) => isAnchorAllowed(anchor.path));
    if (sanitized.length === 0) {
      if (fact.source.kind === "inferred" || fact.source.kind === "manual") {
        unanchoredReasons.set(fact.jsonPath, fact.source.kind);
      }
      continue;
    }
    const list = anchorsByPath.get(fact.jsonPath) ?? [];
    for (const anchor of sanitized) {
      if (!list.some((existing) => anchorEquals(existing, anchor))) {
        list.push(anchor);
      }
    }
    anchorsByPath.set(fact.jsonPath, list);
  }

  const index: AnchorsIndex = {
    $schema: ANCHORS_SCHEMA,
    version: options.version ?? DEFAULT_ANCHORS_VERSION,
    cardSha: options.cardSha,
    runId: options.runId,
    generatedAt: new Date().toISOString(),
    anchorsByPath: Object.fromEntries(anchorsByPath),
    unanchoredReasons: unanchoredReasons.size > 0 ? Object.fromEntries(unanchoredReasons) : undefined
  };

  return normalizeAnchorsIndex(index);
}

function anchorEquals(a: Anchor, b: Anchor): boolean {
  return (
    a.path === b.path &&
    a.startLine === b.startLine &&
    a.endLine === b.endLine &&
    a.commit === b.commit &&
    (a.fingerprint ?? "") === (b.fingerprint ?? "") &&
    (a.kind ?? "") === (b.kind ?? "")
  );
}

function isAnchorAllowed(path: string): boolean {
  return !FORBIDDEN_PATTERNS.some((pattern) => pattern.test(path));
}
