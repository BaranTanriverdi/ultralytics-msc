import { load } from "js-yaml";
import { createPatch } from "rfc6902";
import type { Operation } from "rfc6902";

import { normalizeCard } from "../card/deterministic.js";

export interface DiffReport {
  semanticChanges: Operation[];
  isNoiseOnly: boolean;
  hasSemanticChanges: boolean;
  rawDiffFound: boolean;
}

export function inspectCardDiff(baseContent: string, headContent: string): DiffReport {
  // 1. Check for raw text differences first (fast path)
  const rawDiffFound = baseContent.trim() !== headContent.trim();

  if (!rawDiffFound) {
    return {
      semanticChanges: [],
      isNoiseOnly: false,
      hasSemanticChanges: false,
      rawDiffFound: false
    };
  }

  // 2. Parse and Normalize
  const baseObj = load(baseContent) || {};
  const headObj = load(headContent) || {};

  const baseNormalized = normalizeCard(baseObj);
  const headNormalized = normalizeCard(headObj);

  // 3. Generate Semantic Patch
  // We cast to any because rfc6902 expects objects, and normalizeCard can return primitives (though unlikely for a full card)
  const patch = createPatch(baseNormalized as any, headNormalized as any);

  const hasSemanticChanges = patch.length > 0;
  const isNoiseOnly = rawDiffFound && !hasSemanticChanges;

  return {
    semanticChanges: patch,
    isNoiseOnly,
    hasSemanticChanges,
    rawDiffFound
  };
}
