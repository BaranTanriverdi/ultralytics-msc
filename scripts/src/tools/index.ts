import { readFile } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { performance } from "node:perf_hooks";

import fg from "fast-glob";
import fsExtra from "fs-extra";
import ts from "typescript";

import { logger } from "../utils/logger.js";

import type {
  AstSummaryRequest,
  AstSummaryResponse,
  RepoSearchRequest,
  RepoSearchResponse,
  ToolTrace
} from "./types.js";

const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/.next/**",
  "**/coverage/**",
  "**/.turbo/**"
];

const MAX_CONTEXT_RADIUS = 2;

export async function repoSearch(request: RepoSearchRequest): Promise<ToolTrace<RepoSearchResponse>> {
  const start = performance.now();
  const maxHits = request.maxHits ?? 25;
  const includeGlobs = request.includeGlobs && request.includeGlobs.length > 0 ? request.includeGlobs : ["**/*"];
  const excludes = [...DEFAULT_EXCLUDES, ...(request.excludeGlobs ?? [])];

  logger.debug("repoSearch invoked", {
    query: request.query,
    maxHits,
    include: includeGlobs,
    exclude: excludes
  });

  const entries = await fg(includeGlobs, {
    cwd: process.cwd(),
    ignore: excludes,
    onlyFiles: true,
    dot: false
  });

  const hits: RepoSearchResponse["hits"] = [];
  const queryLower = request.query.toLowerCase();

  for (const relativePath of entries) {
    if (hits.length >= maxHits) {
      break;
    }
    try {
      const absolute = resolve(process.cwd(), relativePath);
      const text = await readFile(absolute, "utf8");
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (hits.length >= maxHits) {
          break;
        }
        const line = lines[index];
        if (!line.toLowerCase().includes(queryLower)) {
          continue;
        }
        const contextStart = Math.max(0, index - MAX_CONTEXT_RADIUS);
        const contextEnd = Math.min(lines.length, index + MAX_CONTEXT_RADIUS + 1);
        hits.push({
          file: relativePath,
          line: index + 1,
          text: line.trim(),
          context: lines.slice(contextStart, contextEnd).map((entry) => entry.trim())
        });
      }
    } catch (error) {
      logger.warn("repoSearch failed to read file", {
        path: relativePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const elapsedMs = performance.now() - start;
  const truncated = hits.length >= maxHits && entries.length > hits.length;
  const response: RepoSearchResponse = { hits, truncated };

  return {
    request,
    response,
    metrics: {
      elapsedMs,
      tokensPrompt: estimateTokens(JSON.stringify(request)),
      tokensCompletion: estimateTokens(JSON.stringify(response))
    }
  };
}

export async function astSummary(request: AstSummaryRequest): Promise<ToolTrace<AstSummaryResponse>> {
  const start = performance.now();
  const absolutePath = resolve(process.cwd(), request.file);

  logger.debug("astSummary invoked", { file: request.file });

  const text = await readFile(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(
    absolutePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    extname(absolutePath).endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const nodes: AstSummaryResponse["nodes"] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      const name = node.name?.getText(sourceFile) ?? "<anonymous>";
      nodes.push(buildNodeSummary(sourceFile, node, name, "function", formatFunctionSignature(sourceFile, node)));
    } else if (ts.isClassDeclaration(node)) {
      const name = node.name?.getText(sourceFile) ?? "<anonymous>";
      nodes.push(buildNodeSummary(sourceFile, node, name, "class"));
    } else if (ts.isInterfaceDeclaration(node)) {
      nodes.push(buildNodeSummary(sourceFile, node, node.name.text, "interface"));
    } else if (ts.isEnumDeclaration(node)) {
      nodes.push(buildNodeSummary(sourceFile, node, node.name.text, "enum"));
    } else if (ts.isVariableStatement(node)) {
      node.declarationList.declarations.forEach((declaration) => {
        const name = declaration.name.getText(sourceFile);
        nodes.push(buildNodeSummary(sourceFile, declaration, name, "variable"));
      });
    } else if (ts.isExportAssignment(node)) {
      nodes.push(buildNodeSummary(sourceFile, node, "default", "export-assignment"));
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  const response: AstSummaryResponse = {
    file: request.file,
    nodes: nodes.sort((a, b) => a.startLine - b.startLine)
  };

  const elapsedMs = performance.now() - start;
  return {
    request,
    response,
    metrics: {
      elapsedMs,
      tokensPrompt: estimateTokens(request.file),
      tokensCompletion: estimateTokens(JSON.stringify(response))
    }
  };
}

function buildNodeSummary(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  name: string,
  kind: string,
  signature?: string
) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    name,
    kind,
    startLine: start.line + 1,
    endLine: end.line + 1,
    signature
  };
}

function formatFunctionSignature(sourceFile: ts.SourceFile, node: ts.FunctionLikeDeclarationBase): string {
  const parameters = node.parameters
    .map((param) => param.getText(sourceFile))
    .join(", ");
  const returnType = node.type ? node.type.getText(sourceFile) : "void";
  const name = node.name?.getText(sourceFile) ?? "anonymous";
  return `${name}(${parameters}) => ${returnType}`;
}

export async function resolveTwoHopNeighbors(path: string): Promise<string[]> {
  const visited = new Set<string>();
  const frontier = new Set<string>([path]);

  for (let depth = 0; depth < 2; depth += 1) {
    const nextFrontier = new Set<string>();
    for (const current of frontier) {
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      const neighbors = await findNeighbors(current);
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          nextFrontier.add(neighbor);
        }
      }
    }
    frontier.clear();
    nextFrontier.forEach((entry) => frontier.add(entry));
  }

  visited.delete(path);
  return Array.from(visited).sort((a, b) => a.localeCompare(b));
}

async function findNeighbors(sourcePath: string): Promise<string[]> {
  try {
    const absolute = resolve(process.cwd(), sourcePath);
    if (!(await fsExtra.pathExists(absolute))) {
      return [];
    }
    const text = await readFile(absolute, "utf8");
    const directory = dirname(sourcePath);
    const neighbors = new Set<string>();

    const importRegex = /import\s+(?:[^"']+?from\s+)?["']([^"']+)["']/g;
    const requireRegex = /require\(\s*["']([^"']+)["']\s*\)/g;

    const collect = (match: RegExpExecArray | null) => {
      if (!match) {
        return;
      }
      const target = match[1];
      const resolved = resolveRelativeModule(directory, target);
      if (resolved) {
        neighbors.add(resolved);
      }
    };

    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(text)) !== null) {
      collect(match);
    }
    while ((match = requireRegex.exec(text)) !== null) {
      collect(match);
    }

    return Array.from(neighbors).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    logger.warn("findNeighbors failed", {
      path: sourcePath,
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}

function resolveRelativeModule(baseDir: string, target: string): string | null {
  if (!target.startsWith(".")) {
    return null;
  }
  const resolved = resolve(baseDir || ".", target)
    .replace(process.cwd(), "")
    .replace(/^\/+/, "");

  const candidates = [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`, `${resolved}.jsx`, `${resolved}/index.ts`, `${resolved}/index.tsx`, `${resolved}/index.js`];

  for (const candidate of candidates) {
    if (fsExtra.existsSync(resolve(process.cwd(), candidate))) {
      return candidate;
    }
  }
  return resolved;
}

function estimateTokens(payload: string | number | boolean | null | undefined): number {
  if (!payload) {
    return 0;
  }
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return Math.ceil(text.length / 4);
}
