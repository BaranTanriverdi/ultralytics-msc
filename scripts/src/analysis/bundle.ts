import { createHash } from "node:crypto";
import { join } from "node:path";

import fsExtra from "fs-extra";

import { ANALYSIS_CACHE_PATH, ANALYSIS_DIR } from "../constants.js";
import { readJsonFile, writeJsonFile } from "../utils/fs.js";
import { logger } from "../utils/logger.js";
import { buildRepositoryInsights, type RepositoryInsights } from "./repository.js";
import { isPathDenied, isMscInfrastructure } from "../safety/redaction.js";
import { astSummary, resolveTwoHopNeighbors } from "../tools/index.js";
import type { AstSummaryResponse } from "../tools/types.js";
import { collectDependencyGraph, type DependencyGraph } from "./dependencies.js";
import {
  collectRepositoryStaticSignals,
  type RepositoryStaticSignals
} from "./signals.js";

export interface FileEvidence {
  path: string;
  contentSha: string;
  summary: string;
  preview: string[];
  size: number;
  cacheHit: boolean;
  neighbors: string[];
  ast?: AstSummaryResponse;
  status?: "missing";
}

export interface AnalysisToolCall {
  tool: string;
  target: string;
  traceDigest: string;
  metrics: {
    elapsedMs: number;
    tokensPrompt: number;
    tokensCompletion: number;
  };
}

interface AnalysisCacheEntry {
  contentSha: string;
  summary: string;
  preview: string[];
  size: number;
  updatedAt: string;
}

interface AnalysisCacheFile {
  version: number;
  entries: Record<string, AnalysisCacheEntry>;
}

const CACHE_VERSION = 3;
const CACHE_MAX_ENTRIES = 500;
const CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export interface AnalysisBundle {
  metadata: {
    runId: string;
    baseSha: string;
    headSha: string;
    generatedAt: string;
    cacheDigest: string;
  };
  changedFiles: string[];
  fileEvidence: FileEvidence[];
  repository: RepositoryInsights;
  astSummaries: Record<string, AstSummaryResponse>;
  dependencyGraph: DependencyGraph;
  staticSignals: RepositoryStaticSignals;
  toolCalls: AnalysisToolCall[];
  warnings: string[];
  artifactPath: string;
}

interface BuildParams {
  runId: string;
  baseSha: string;
  headSha: string;
  changedFiles: string[];
}
interface BuildOptions {
  outputDir?: string;
  cachePath?: string;
}

export async function buildAnalysisBundle(
  params: BuildParams,
  options: BuildOptions = {}
): Promise<AnalysisBundle> {
  const { runId, baseSha, headSha, changedFiles } = params;
  const analysisDir = options.outputDir ?? ANALYSIS_DIR;
  const cachePath = options.cachePath ?? ANALYSIS_CACHE_PATH;
  await ensureRequiredFiles();

  const repository = await buildRepositoryInsights({ runId, headSha });
  const cache = await readAnalysisCache(cachePath);
  const cacheEntries = { ...cache.entries };
  const fileEvidence: FileEvidence[] = [];
  const warnings: string[] = [];
  let cacheHits = 0;
  const toolCalls: AnalysisToolCall[] = [];

  for (const relativePath of changedFiles) {
    if (isPathDenied(relativePath)) {
      warnings.push(`Skipped deny-listed path: ${relativePath}`);
      continue;
    }
    if (isMscInfrastructure(relativePath)) {
      continue;
    }
    const evidence = await buildFileEvidence(relativePath, cacheEntries);
    if (evidence.cacheHit) {
      cacheHits += 1;
    }
    fileEvidence.push(evidence);
  }

  const astSummaries: Record<string, AstSummaryResponse> = {};
  for (const evidence of fileEvidence) {
    if (evidence.status === "missing") {
      continue;
    }
    if (!/\.(t|j)sx?$/.test(evidence.path)) {
      evidence.neighbors = [];
      continue;
    }
    try {
      const trace = await astSummary({ file: evidence.path });
      astSummaries[evidence.path] = trace.response;
      evidence.ast = trace.response;
      toolCalls.push({
        tool: "astSummary",
        target: evidence.path,
        traceDigest: createHash("sha256")
          .update(JSON.stringify(trace.request ?? {}))
          .digest("hex"),
        metrics: trace.metrics
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to summarize AST for ${evidence.path}: ${message}`);
    }
    try {
      evidence.neighbors = await resolveTwoHopNeighbors(evidence.path);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to resolve neighbors for ${evidence.path}: ${message}`);
    }
  }

  evictCacheEntries(cacheEntries);
  const dependencyGraph = await collectDependencyGraph();
  const { signals: staticSignals, warnings: signalWarnings } = await collectRepositoryStaticSignals();
  if (signalWarnings.length > 0) {
    warnings.push(...signalWarnings);
  }

  const updatedCache: AnalysisCacheFile = {
    version: CACHE_VERSION,
    entries: cacheEntries
  };
  const cacheDigest = computeCacheDigest(cacheEntries);
  const artifactPath = join(analysisDir, `${runId}.json`);

  const bundle: AnalysisBundle = {
    metadata: {
      runId,
      baseSha,
      headSha,
      generatedAt: new Date().toISOString(),
      cacheDigest
    },
    changedFiles,
    fileEvidence,
    repository,
    astSummaries,
    dependencyGraph,
    staticSignals,
    toolCalls,
    warnings: [...warnings, ...computeWarnings(fileEvidence)],
    artifactPath
  };

  await fsExtra.ensureDir(analysisDir);
  await writeJsonFile(artifactPath, bundle);
  await writeAnalysisCache(updatedCache, analysisDir, cachePath);

  logger.info("Analysis bundle prepared", {
    runId,
    artifact: artifactPath,
    changedFiles: changedFiles.length,
    cacheHitRatio: changedFiles.length === 0 ? 1 : cacheHits / changedFiles.length
  });

  return bundle;
}

async function ensureRequiredFiles(): Promise<void> {
  const requiredPaths = ["docs/stakeholders.yaml", "README.md"];
  for (const path of requiredPaths) {
    const exists = await fsExtra.pathExists(path);
    if (!exists) {
      throw new Error(`Required project file missing: ${path}`);
    }
  }
}

async function buildFileEvidence(
  relativePath: string,
  cacheEntries: Record<string, AnalysisCacheEntry>
): Promise<FileEvidence> {
  const absoluteExists = await fsExtra.pathExists(relativePath);
  if (!absoluteExists) {
    delete cacheEntries[relativePath];
    return {
      path: relativePath,
      contentSha: "missing",
      summary: "",
      preview: [],
      size: 0,
      cacheHit: false,
      neighbors: [],
      status: "missing"
    };
  }

  const stats = await fsExtra.stat(relativePath);
  if (!stats.isFile()) {
    delete cacheEntries[relativePath];
    return {
      path: relativePath,
      contentSha: "non-file",
      summary: "",
      preview: [],
      size: 0,
      cacheHit: false,
      neighbors: [],
      status: "missing"
    };
  }

  const content = await fsExtra.readFile(relativePath, "utf8");
  const contentSha = createHash("sha256").update(content).digest("hex");
  const cached = cacheEntries[relativePath];
  const cacheHit = cached?.contentSha === contentSha;

  if (cacheHit) {
    return {
      path: relativePath,
      contentSha,
      summary: cached.summary,
      preview: cached.preview,
      size: cached.size,
      cacheHit: true,
      neighbors: []
    };
  }

  const { summary, preview } = summarizeContent(content, relativePath);
  const entry: AnalysisCacheEntry = {
    contentSha,
    summary,
    preview,
    size: content.length,
    updatedAt: new Date().toISOString()
  };
  cacheEntries[relativePath] = entry;

  return {
    path: relativePath,
    contentSha,
    summary,
    preview,
    size: entry.size,
    cacheHit: false,
    neighbors: []
  };
}

function summarizeContent(content: string, filePath: string): { summary: string; preview: string[] } {
  if (filePath.endsWith(".ipynb")) {
    return summarizeNotebook(content);
  }
  const lines = content.split(/\r?\n/);
  // Capture more content for the LLM to analyze (up to 1000 lines)
  const preview = lines.slice(0, 1000).map((line) => line.trimEnd().slice(0, 500));
  const summary = preview.slice(0, 5).join(" ").slice(0, 512);
  return { summary, preview };
}

export function summarizeNotebook(content: string): { summary: string; preview: string[] } {
  try {
    const notebook = JSON.parse(content);
    const cells = notebook.cells || [];
    const preview: string[] = [];
    let linesCount = 0;
    const MAX_NOTEBOOK_LINES = 1000;

    for (const cell of cells) {
      if (linesCount >= MAX_NOTEBOOK_LINES) break;

      // Handle both string and array formats for source
      const sourceLines = Array.isArray(cell.source)
        ? cell.source.flatMap((s: string) => s.split(/\r?\n/))
        : (cell.source || "").split(/\r?\n/);

      if (sourceLines.length === 0 || (sourceLines.length === 1 && !sourceLines[0].trim())) continue;

      if (cell.cell_type === "code") {
        preview.push(`[Code]`);
        preview.push(...sourceLines.map((l: string) => l.trimEnd()));
        linesCount += sourceLines.length + 1;
      } else if (cell.cell_type === "markdown") {
        preview.push(`[Markdown]`);
        preview.push(...sourceLines.map((l: string) => l.trimEnd()));
        linesCount += sourceLines.length + 1;
      }
      preview.push(""); // Spacer
      linesCount++;
    }

    if (linesCount >= MAX_NOTEBOOK_LINES) {
      preview.push("... (truncated notebook)");
    }

    const summary = preview.slice(0, 5).join(" ").slice(0, 512);
    return { summary, preview };
  } catch {
    const lines = content.split(/\r?\n/);
    const preview = lines.slice(0, 50).map((line) => line.trim().slice(0, 160));
    const summary = preview.join(" ").slice(0, 512);
    return { summary, preview };
  }
}

async function readAnalysisCache(cachePath: string): Promise<AnalysisCacheFile> {
  const cache = await readJsonFile<AnalysisCacheFile>(cachePath);
  if (!cache || cache.version !== CACHE_VERSION) {
    return { version: CACHE_VERSION, entries: {} };
  }
  return cache;
}

async function writeAnalysisCache(
  cache: AnalysisCacheFile,
  analysisDir: string,
  cachePath: string
): Promise<void> {
  await fsExtra.ensureDir(analysisDir);
  await writeJsonFile(cachePath, cache);
}

function computeCacheDigest(entries: Record<string, AnalysisCacheEntry>): string {
  const normalized = Object.keys(entries)
    .sort()
    .map((key) => `${key}:${entries[key].contentSha}`)
    .join("|");
  return createHash("sha256").update(normalized).digest("hex");
}

function computeWarnings(fileEvidence: FileEvidence[]): string[] {
  const warnings: string[] = [];
  fileEvidence
    .filter((entry) => entry.status === "missing")
    .forEach((entry) => {
      warnings.push(`Changed file missing from working tree: ${entry.path}`);
    });
  return warnings;
}

function evictCacheEntries(entries: Record<string, AnalysisCacheEntry>): void {
  const now = Date.now();
  for (const [path, entry] of Object.entries(entries)) {
    const age = now - Date.parse(entry.updatedAt ?? "");
    if (Number.isFinite(age) && age > CACHE_MAX_AGE_MS) {
      delete entries[path];
    }
  }

  const keys = Object.keys(entries);
  if (keys.length <= CACHE_MAX_ENTRIES) {
    return;
  }
  const sorted = keys.sort((a, b) => Date.parse(entries[a].updatedAt) - Date.parse(entries[b].updatedAt));
  for (let i = 0; i < sorted.length - CACHE_MAX_ENTRIES; i += 1) {
    delete entries[sorted[i]];
  }
}
