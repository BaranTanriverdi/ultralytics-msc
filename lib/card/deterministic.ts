import crypto from "node:crypto";
import { dump } from "js-yaml";

import type { AnchorsIndex } from "./types.js";

type Comparator<T> = (a: T, b: T) => number;

type Path = string;

type SorterMap = Record<Path, Comparator<unknown>>;

const ARRAY_SORTERS: SorterMap = {
  "business.kpis": compareBy<string>(["name"], "asc"),
  "governance.riskRegister": (a, b) => {
    const likelihoodOrder = compareNumber(getNumber(b, "likelihood"), getNumber(a, "likelihood"));
    if (likelihoodOrder !== 0) return likelihoodOrder;
    const impactOrder = compareNumber(getNumber(b, "impact"), getNumber(a, "impact"));
    if (impactOrder !== 0) return impactOrder;
    return compareString(getString(a, "item"), getString(b, "item"));
  },
  "governance.signOffs": compareBy<Date>(["timestamp"], "asc", parseDateComparator),
  "mlCore.metrics": (a, b) => {
    const sliceOrder = compareString(getString(a, "slice"), getString(b, "slice"));
    if (sliceOrder !== 0) return sliceOrder;
    return compareString(getString(a, "metric"), getString(b, "metric"));
  },
  "mlCore.qualities": (a, b) => {
    const categoryOrder = compareString(getString(a, "category"), getString(b, "category"));
    if (categoryOrder !== 0) return categoryOrder;
    return compareString(getString(a, "evaluationProtocol"), getString(b, "evaluationProtocol"));
  },
  "mlCore.failureModes": (a, b) => compareString(getString(a, "name"), getString(b, "name")),
  "provenance.changelog": compareBy<Date>(["date"], "asc", parseDateComparator),
  "integration.operationalQualities": (a, b) => compareString(getString(a, "name"), getString(b, "name")),
  "integration.operationalQualities.targets": (a, b) => compareString(getString(a, "label"), getString(b, "label")),
  "integration.operationalQualities.measures": (a, b) => compareString(getString(a, "label"), getString(b, "label")),
  "ai.fieldMeta": (a, b) => compareString(getString(a, "path"), getString(b, "path"))
};

const SIGNIFICANT_DIGITS = 3;

const ISO_REGEX = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z?$/;

export interface StringifyOptions {
  includeSchema?: boolean;
}

export function normalizeCard<T>(input: T, basePath: string[] = []): T {
  if (Array.isArray(input)) {
    const pathKey = basePath.join(".");
    const normalized = input.map((item, index) => normalizeCard(item, [...basePath, String(index)]));
    const sorter = ARRAY_SORTERS[pathKey] as Comparator<unknown> | undefined;
    if (sorter) {
      return [...normalized].sort(sorter) as T;
    }
    return normalized as T;
  }

  if (input && typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>)
      .map(([key, value]) => {
        const nextPath = [...basePath, key];
        return [key, normalizeCard(value, nextPath)] as const;
      })
      .sort(([a], [b]) => a.localeCompare(b));

    return Object.fromEntries(entries) as T;
  }

  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      return null as T;
    }

    if (input === 0) {
      return 0 as T;
    }

    const rounded = Number.parseFloat(input.toPrecision(SIGNIFICANT_DIGITS));
    return rounded as T;
  }

  if (typeof input === "string") {
    if (ISO_REGEX.test(input)) {
      const iso = new Date(input).toISOString();
      return iso as T;
    }
  }

  return input;
}

export function stringifyDeterministic(card: unknown): string {
  const normalized = normalizeCard(card);
  const yaml = dump(normalized, {
    noRefs: true,
    sortKeys: true,
    lineWidth: 120,
    noCompatMode: true
  });
  return ensureLf(ensureFinalNewline(yaml));
}

export function computeSha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export function ensureFinalNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

export function ensureLf(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

export function normalizeAnchorsIndex(index: AnchorsIndex): AnchorsIndex {
  const { anchorsByPath, ...meta } = index;
  const sortedPaths = Object.keys(anchorsByPath).sort((a, b) => a.localeCompare(b));
  const sortedAnchors = Object.fromEntries(
    sortedPaths.map((path) => [path, [...anchorsByPath[path]].sort(anchorComparator)])
  );

  return normalizeCard({ ...meta, anchorsByPath: sortedAnchors }) as AnchorsIndex;
}

function anchorComparator(a: any, b: any): number {
  return (
    compareString(getString(a, "path"), getString(b, "path")) ||
    compareNumber(getNumber(a, "startLine"), getNumber(b, "startLine")) ||
    compareNumber(getNumber(a, "endLine"), getNumber(b, "endLine")) ||
    compareString(getString(a, "commit"), getString(b, "commit"))
  );
}

function compareBy<T>(keys: string[], direction: "asc" | "desc", valueMapper?: (value: unknown) => T): Comparator<any> {
  return (left, right) => {
    for (const key of keys) {
      const l = valueMapper ? valueMapper((left as any)[key]) : (left as any)[key];
      const r = valueMapper ? valueMapper((right as any)[key]) : (right as any)[key];

      const comparison = compareUnknown(l, r);
      if (comparison !== 0) {
        return direction === "asc" ? comparison : -comparison;
      }
    }
    return 0;
  };
}

function parseDateComparator(value: unknown): number {
  if (typeof value !== "string") return Number.NEGATIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function compareUnknown(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") {
    return compareNumber(a, b);
  }
  return compareString(String(a ?? ""), String(b ?? ""));
}

function compareNumber(a: number, b: number): number {
  return Number(a) - Number(b);
}

function compareString(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function getNumber(value: unknown, key: string): number {
  if (typeof value === "object" && value !== null && typeof (value as any)[key] === "number") {
    return (value as any)[key];
  }
  return Number.NEGATIVE_INFINITY;
}

function getString(value: unknown, key: string): string {
  if (typeof value === "object" && value !== null && typeof (value as any)[key] === "string") {
    return (value as any)[key];
  }
  return "";
}
