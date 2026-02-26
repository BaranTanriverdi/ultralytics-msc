import crypto from "node:crypto";
import { dump } from "js-yaml";

import type { AnchorsIndex } from "lib/card/types.js";

type AnyRecord = Record<string, any>;
type Sorter = (a: any, b: any) => number;

const SIGNIFICANT_DIGITS = 3;

const arraySorters: Record<string, Sorter> = {
  "ai.fieldMeta": (a, b) => compareString(a?.path, b?.path),
  "business.kpis": (a, b) => compareString(a?.name, b?.name),
  "governance.riskRegister": (a, b) =>
    compareNumber(b?.likelihood, a?.likelihood) ||
    compareNumber(b?.impact, a?.impact) ||
    compareString(a?.item, b?.item),
  "governance.signOffs": (a, b) => compareDate(a?.timestamp, b?.timestamp),
  "integration.operationalQualities": (a, b) => compareString(a?.name, b?.name),
  "integration.operationalQualities.targets": (a, b) => compareString(a?.label, b?.label),
  "integration.operationalQualities.measures": (a, b) => compareString(a?.label, b?.label),
  "mlCore.failureModes": (a, b) => compareString(a?.name, b?.name),
  "mlCore.metrics": (a, b) => compareString(a?.slice, b?.slice) || compareString(a?.metric, b?.metric),
  "mlCore.qualities": (a, b) =>
    compareString(a?.category, b?.category) || compareString(a?.evaluationProtocol, b?.evaluationProtocol),
  "provenance.changelog": (a, b) => compareDate(a?.date, b?.date)
};

export type Normalized<T> = T;

export function normalizeCard<T>(value: T, path: string[] = []): Normalized<T> {
  if (Array.isArray(value)) {
    const pathKey = path.join(".");
    const normalized = value.map((item, index) => normalizeCard(item, [...path, String(index)]));
    const sorter = arraySorters[pathKey];
    if (sorter) {
      return [...normalized].sort(sorter) as Normalized<T>;
    }
    return normalized as Normalized<T>;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as AnyRecord)
      .map(([key, child]) => [key, normalizeCard(child, [...path, key])])
      .sort(([a], [b]) => a.localeCompare(b));

    return Object.fromEntries(entries) as Normalized<T>;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null as Normalized<T>;
    }
    if (value === 0) {
      return 0 as Normalized<T>;
    }
    const rounded = Number.parseFloat(value.toPrecision(SIGNIFICANT_DIGITS));
    return rounded as Normalized<T>;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed) && value.toUpperCase().includes("T")) {
      return new Date(parsed).toISOString() as Normalized<T>;
    }
  }

  return value as Normalized<T>;
}

export function stringifyDeterministic(card: unknown): string {
  const normalized = normalizeCard(card);
  const yaml = dump(normalized, {
    noRefs: true,
    sortKeys: true,
    lineWidth: 120,
    noCompatMode: true
  });
  return ensureLf(ensureTrailingNewline(yaml));
}

export function ensureTrailingNewline(input: string): string {
  return input.endsWith("\n") ? input : `${input}\n`;
}

export function ensureLf(input: string): string {
  return input.replace(/\r\n/g, "\n");
}

export function computeSha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export function normalizeAnchorsIndex(index: AnchorsIndex): AnchorsIndex {
  const { anchorsByPath, unanchoredReasons, ...meta } = index;
  const sortedPaths = Object.keys(anchorsByPath).sort((a, b) => a.localeCompare(b));
  const normalizedAnchors = Object.fromEntries(
    sortedPaths.map((jsonPath) => [jsonPath, [...anchorsByPath[jsonPath]].sort(compareAnchors)])
  );

  const normalizedReasons = unanchoredReasons
    ? Object.fromEntries(Object.entries(unanchoredReasons).sort(([a], [b]) => a.localeCompare(b)))
    : undefined;

  return normalizeCard({
    ...meta,
    anchorsByPath: normalizedAnchors,
    ...(normalizedReasons ? { unanchoredReasons: normalizedReasons } : {})
  }) as AnchorsIndex;
}

function compareAnchors(a: AnyRecord, b: AnyRecord): number {
  return (
    compareString(a?.path, b?.path) ||
    compareNumber(a?.startLine, b?.startLine) ||
    compareNumber(a?.endLine, b?.endLine) ||
    compareString(a?.commit, b?.commit)
  );
}

function compareString(left: unknown, right: unknown): number {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, { sensitivity: "base" });
}

function compareNumber(left: unknown, right: unknown): number {
  return Number(left ?? Number.NEGATIVE_INFINITY) - Number(right ?? Number.NEGATIVE_INFINITY);
}

function compareDate(left: unknown, right: unknown): number {
  const l = Date.parse(String(left ?? ""));
  const r = Date.parse(String(right ?? ""));
  return (Number.isNaN(l) ? Number.NEGATIVE_INFINITY : l) -
    (Number.isNaN(r) ? Number.NEGATIVE_INFINITY : r);
}
