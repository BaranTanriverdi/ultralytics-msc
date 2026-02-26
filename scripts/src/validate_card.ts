import { load } from "js-yaml";
import Ajv from "ajv";
import addFormats from "ajv-formats";

import {
  ANCHORS_PATH,
  CARD_PATH,
  COVERAGE_THRESHOLD,
  SCHEMA_PATH
} from "./constants.js";
import {
  ensureLf,
  ensureTrailingNewline,
  normalizeAnchorsIndex,
  stringifyDeterministic
} from "./card/deterministic.js";
import { readTextFile, writeTextFile } from "./utils/fs.js";
import type { AnchorsIndex } from "lib/card/types.js";

export interface ValidationOutcome {
  schemaValid: boolean;
  anchorsSchemaValid: boolean;
  cardIdempotent: boolean;
  anchorsIdempotent: boolean;
  coverage: number;
  coverageThreshold: number;
  errors: string[];
}

export interface ValidationOptions {
  cardPath?: string;
  anchorsPath?: string;
  schemaPath?: string;
  anchorsSchemaPath?: string;
  coverageThreshold?: number;
  fixFormatting?: boolean;
}

export async function validateCardArtifacts(options: ValidationOptions = {}): Promise<ValidationOutcome> {
  const cardPath = options.cardPath ?? CARD_PATH;
  const anchorsPath = options.anchorsPath ?? ANCHORS_PATH;
  const schemaPath = options.schemaPath ?? SCHEMA_PATH;
  const coverageThreshold = options.coverageThreshold ?? COVERAGE_THRESHOLD;

  const errors: string[] = [];

  const rawCard = await readTextFile(cardPath);
  if (!rawCard) {
    throw new Error(`Card file missing at ${cardPath}`);
  }
  const normalizedCard = ensureTrailingNewline(ensureLf(rawCard));

  const schemaContentRaw = await readTextFile(schemaPath);
  if (!schemaContentRaw) {
    throw new Error(`Schema file missing at ${schemaPath}`);
  }
  const schemaContent = JSON.parse(schemaContentRaw) as Record<string, unknown>;
  if (!schemaContent) {
    throw new Error(`Schema file missing at ${schemaPath}`);
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schemaContent);

  const cardObject = load(normalizedCard) ?? {};
  const schemaValid = validate(cardObject) as boolean;
  if (!schemaValid && validate.errors) {
    errors.push(...validate.errors.map((err) => `${err.instancePath} ${err.message ?? "invalid"}`));
  }

  const deterministicCard = stringifyDeterministic(cardObject);
  const cardIdempotent = deterministicCard === normalizedCard;
  if (!cardIdempotent) {
    errors.push("Card YAML is not deterministic under round-trip serialization");
    if (options.fixFormatting) {
      await writeTextFile(cardPath, deterministicCard);
    }
  }

  const anchorsRawText = await readTextFile(anchorsPath);
  if (!anchorsRawText) {
    throw new Error(`Anchors index missing at ${anchorsPath}`);
  }

  const anchorsRaw = JSON.parse(anchorsRawText) as AnchorsIndex;
  const normalizedAnchors = normalizeAnchorsIndex(anchorsRaw);
  const canonicalAnchors = JSON.stringify(normalizedAnchors, null, 2) + "\n";
  const anchorsIdempotent = canonicalAnchors === ensureTrailingNewline(ensureLf(anchorsRawText));
  if (!anchorsIdempotent) {
    errors.push("Anchors index is not deterministic under normalization");
  }

  const anchorsSchemaValid = validateAnchorsIndex(normalizedAnchors);
  if (!anchorsSchemaValid) {
    errors.push("Anchors index failed structural validation");
  }

  const coverage = computeCoverage(cardObject, normalizedAnchors);
  if (coverage < coverageThreshold) {
    // Debug info for why coverage failed
    const requiredPaths = collectStructuredPaths(cardObject, "$", []);
    const anchorPaths = new Set(Object.keys(normalizedAnchors.anchorsByPath));
    const missing = requiredPaths.filter(p => !anchorPaths.has(p));
    console.log(`[DEBUG] Coverage failed. Missing anchors for: ${missing.slice(0, 5).join(", ")}`);

    errors.push(
      `Evidence coverage ${coverage.toFixed(3)} below threshold ${coverageThreshold.toFixed(3)}`
    );
  }

  return {
    schemaValid,
    anchorsSchemaValid,
    cardIdempotent,
    anchorsIdempotent,
    coverage,
    coverageThreshold,
    errors
  };
}

function validateAnchorsIndex(index: AnchorsIndex): boolean {
  if (!index.cardSha || typeof index.cardSha !== "string") {
    return false;
  }
  if (!index.anchorsByPath || typeof index.anchorsByPath !== "object") {
    return false;
  }
  return Object.entries(index.anchorsByPath).every(([jsonPath, anchors]) => {
    if (!jsonPath.startsWith("$")) {
      return false;
    }
    if (!Array.isArray(anchors) || anchors.length === 0) {
      return false;
    }
    return anchors.every((anchor) =>
      typeof anchor.path === "string" &&
      typeof anchor.startLine === "number" &&
      typeof anchor.endLine === "number" &&
      typeof anchor.commit === "string"
    );
  });
}

function computeCoverage(card: unknown, anchorsIndex: AnchorsIndex): number {
  const anchorPaths = new Set(Object.keys(anchorsIndex.anchorsByPath));
  if (anchorsIndex.unanchoredReasons) {
    Object.keys(anchorsIndex.unanchoredReasons).forEach((path) => anchorPaths.add(path));
  }
  const requiredPaths = collectStructuredPaths(card, "$", []);
  if (requiredPaths.length === 0) {
    return 1;
  }
  const covered = requiredPaths.filter((path) => anchorPaths.has(path)).length;
  return covered / requiredPaths.length;
}

const OPTIONAL_PREFIXES = ["$.stakeholderNotes", "$.ai", "$.provenance", "$.meta"];

function collectStructuredPaths(value: unknown, jsonPath: string, acc: string[]): string[] {
  if (value === null || value === undefined) {
    return acc;
  }

  if (typeof value !== "object") {
    if (OPTIONAL_PREFIXES.some((prefix) => jsonPath.startsWith(prefix))) {
      return acc;
    }
    acc.push(jsonPath);
    return acc;
  }

  if (Array.isArray(value)) {
    value.forEach((item, idx) => {
      collectStructuredPaths(item, `${jsonPath}[${idx}]`, acc);
    });
    return acc;
  }

  Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
    const nextPath = `${jsonPath}.${key}`;
    collectStructuredPaths(child, nextPath, acc);
  });

  return acc;
}
