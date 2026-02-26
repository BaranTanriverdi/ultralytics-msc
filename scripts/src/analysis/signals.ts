import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import fg from "fast-glob";
import { load } from "js-yaml";

import { logger } from "../utils/logger.js";

export interface RepositoryStaticSignals {
  coverage: Array<{ type: string; percentage: number; source: string }>;
  openApiSpecs: Array<{ path: string; title?: string; version?: string }>;
  metrics: Array<{ name: string; value: string; source: string }>;
}

const COVERAGE_GLOBS = ["**/coverage-summary.json", "**/lcov-report/index.html"];
const OPENAPI_GLOBS = ["**/*openapi*.{json,yaml,yml}", "**/swagger*.{json,yaml,yml}"];
const METRICS_CANDIDATES = ["docs/metrics.yaml", "docs/metrics.yml", "docs/metrics.json"];

export interface StaticSignalResult {
  signals: RepositoryStaticSignals;
  warnings: string[];
}

export async function collectRepositoryStaticSignals(): Promise<StaticSignalResult> {
  const warnings: string[] = [];
  const signals: RepositoryStaticSignals = {
    coverage: [],
    openApiSpecs: [],
    metrics: []
  };

  try {
    const coverageMatches = await fg(COVERAGE_GLOBS, {
      cwd: process.cwd(),
      ignore: ["**/node_modules/**", "**/.git/**", "**/.next/**", "**/dist/**"],
      onlyFiles: true
    });
    for (const match of coverageMatches) {
      if (match.endsWith("coverage-summary.json")) {
        try {
          const raw = await readFile(match, "utf8");
          const parsed = JSON.parse(raw) as {
            total?: { lines?: { pct?: number }; statements?: { pct?: number } };
          };
          const pct = parsed.total?.lines?.pct ?? parsed.total?.statements?.pct;
          if (typeof pct === "number") {
            signals.coverage.push({ type: "lines", percentage: pct / 100, source: match });
          }
        } catch (error) {
          warnings.push(`Unable to parse coverage summary ${match}: ${formatError(error)}`);
        }
      } else if (match.endsWith("index.html")) {
        signals.coverage.push({ type: "lcov-report", percentage: 0, source: match });
      }
    }
  } catch (error) {
    warnings.push(`Coverage scan failed: ${formatError(error)}`);
  }

  try {
    const openApiMatches = await fg(OPENAPI_GLOBS, {
      cwd: process.cwd(),
      ignore: ["**/node_modules/**", "**/.git/**"],
      onlyFiles: true
    });
    for (const match of openApiMatches) {
      try {
        const raw = await readFile(match, "utf8");
        const info = extractOpenApiInfo(raw, match);
        if (info) {
          signals.openApiSpecs.push(info);
        }
      } catch (error) {
        warnings.push(`Unable to parse OpenAPI spec ${match}: ${formatError(error)}`);
      }
    }
  } catch (error) {
    warnings.push(`OpenAPI scan failed: ${formatError(error)}`);
  }

  for (const candidate of METRICS_CANDIDATES) {
    try {
      const raw = await readFile(candidate, "utf8");
      const metrics = parseMetrics(candidate, raw);
      metrics.forEach((metric) => signals.metrics.push(metric));
    } catch (error: any) {
      if (error && error.code === "ENOENT") {
        continue;
      }
      warnings.push(`Unable to parse metrics file ${candidate}: ${formatError(error)}`);
    }
  }

  if (signals.coverage.length === 0) {
    warnings.push("No coverage signals detected. Provide coverage-summary.json to unlock coverage-aware prompts.");
  }
  if (signals.openApiSpecs.length === 0) {
    warnings.push("No OpenAPI specs detected. Place openapi.yaml near service entrypoints to surface integration facts.");
  }

  return { signals, warnings };
}

function extractOpenApiInfo(raw: string, path: string): { path: string; title?: string; version?: string } | null {
  try {
    if (extname(path).toLowerCase() === ".json") {
      const parsed = JSON.parse(raw) as { info?: { title?: string; version?: string } };
      return {
        path,
        title: parsed.info?.title,
        version: parsed.info?.version
      };
    }
    const parsed = load(raw) as { info?: { title?: string; version?: string } } | null;
    if (!parsed || typeof parsed !== "object") {
      return { path };
    }
    return {
      path,
      title: parsed.info?.title as string | undefined,
      version: parsed.info?.version as string | undefined
    };
  } catch (error) {
    logger.warn("Failed to extract OpenAPI info", {
      path,
      error: formatError(error)
    });
    return { path };
  }
}

function parseMetrics(path: string, raw: string): Array<{ name: string; value: string; source: string }> {
  if (extname(path).toLowerCase() === ".json") {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(parsed).map(([name, value]) => ({
      name,
      value: typeof value === "number" ? value.toString() : JSON.stringify(value),
      source: path
    }));
  }

  const parsed = load(raw);
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const record = parsed as Record<string, unknown>;
  return Object.entries(record).map(([name, value]) => ({
    name,
    value: typeof value === "number" ? value.toString() : JSON.stringify(value),
    source: path
  }));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
