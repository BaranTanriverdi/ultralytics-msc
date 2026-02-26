import { resolve, dirname, extname, join } from "node:path";
import { promises as fs, accessSync, constants } from "node:fs";

import { dedupe } from "./utils/path.js";
import { diffNameOnly, lsFiles } from "./utils/git.js";
import { extractPythonImports } from "./analysis/ast.js";

const CRITICAL_PATTERNS = [
  "openapi.*",
  "README.md",
  "docs/adr/**",
  "bench/**",
  "metrics/**",
  "coverage.xml",
  ".github/workflows/**",
  "config/**",
  "setup.py",
  "setup.cfg",
  "pyproject.toml",
  "environment.yaml",
  "requirements.txt",
  "src/**/*.py",
  "src/**/*.ts",
  "src/**/*.js",
  "notebooks/**/*.ipynb"
];

const IMPORT_REGEX = /import\s+(?:[^"']+?from\s+)?["']([^"']+)["']/g;
const REQUIRE_REGEX = /require\(["']([^"']+)["']\)/g;
const MAX_HOPS = 2;
const SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py", ".ipynb"];

export interface IncrementalSetResult {
  changed: string[];
  neighbors: string[];
  critical: string[];
  combined: string[];
}

export async function computeIncrementalFileSet(baseSha: string, headSha: string): Promise<IncrementalSetResult> {
  const changed = await diffNameOnly(baseSha, headSha);
  const neighborSet = await collectNeighbors(changed);
  const critical = await lsFiles(CRITICAL_PATTERNS);

  const combined = dedupe([...changed, ...neighborSet, ...critical]);

  return {
    changed,
    neighbors: neighborSet,
    critical,
    combined
  };
}

async function collectNeighbors(seedFiles: string[]): Promise<string[]> {
  const visited = new Set<string>();
  const queue: Array<{ path: string; depth: number }> = seedFiles.map((path) => ({ path, depth: 0 }));

  while (queue.length > 0) {
    const { path, depth } = queue.shift()!;
    if (visited.has(path) || depth >= MAX_HOPS) {
      continue;
    }
    visited.add(path);

  const dependencies = await extractRelativeImports(path);
    for (const dep of dependencies) {
      if (!visited.has(dep)) {
        queue.push({ path: dep, depth: depth + 1 });
      }
    }
  }

  return Array.from(visited).filter(Boolean);
}

async function extractRelativeImports(filePath: string): Promise<string[]> {
  try {
    const absolutePath = resolve(process.cwd(), filePath);
    const content = await fs.readFile(absolutePath, "utf8");
    const ext = extname(filePath);

    if (ext === ".py") {
       const imports = await extractPythonImports(content);
       // Basic resolution strategy for Python
       // 1. Explicit relative imports (starting with .)
       // 2. Absolute imports that match files in the project
       const resolved = imports.map(imp => {
           if (imp.startsWith(".")) {
               const match = imp.match(/^(\.+)(.*)$/);
               if (!match) return null;

               const dots = match[1];
               const rest = match[2];

               // dots="." (len 1) -> current dir (0 calls to dirname)
               // dots=".." (len 2) -> parent (1 call to dirname)
               let searchDir = dirname(absolutePath);
               for (let i = 1; i < dots.length; i++) {
                 searchDir = dirname(searchDir);
               }

               const parts = rest ? rest.split(".") : [];
               const candidatePath = resolve(searchDir, ...parts);

               // Check file.py or file/__init__.py or just file.ts etc
               let hit = toSupportedExtension(candidatePath);
               if (hit) return hit;

               hit = toSupportedExtension(resolve(candidatePath, "__init__"));
               if (hit) return hit;

               return null;
           }
           // Try to find module at project root or relative to file
           const parts = imp.split(".");
           const candidatePath = parts.join("/");

           // Check adjacent sibling
           const sibling = resolve(dirname(absolutePath), candidatePath);
           if (toSupportedExtension(sibling)) return toSupportedExtension(sibling);

           // Check from root
           const fromRoot = resolve(process.cwd(), candidatePath);
           if (toSupportedExtension(fromRoot)) return toSupportedExtension(fromRoot);

           return null;
       }).filter(Boolean) as string[];

       return dedupe(resolved.map(abs => normalizePath(abs)));
    }

    const matches = [...content.matchAll(IMPORT_REGEX), ...content.matchAll(REQUIRE_REGEX)];
    const relPaths = matches
      .map((match) => match[1])
      .filter((p) => p && (p.startsWith("./") || p.startsWith("../")));
    const resolved = relPaths
      .map((rel) => toSupportedExtension(resolve(dirname(absolutePath), rel)))
      .filter(Boolean) as string[];
    return dedupe(resolved.map((abs) => normalizePath(abs)));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function toSupportedExtension(resolvedPath: string): string | null {
  if (SUPPORTED_EXTENSIONS.some((ext) => resolvedPath.endsWith(ext))) {
    return resolvedPath;
  }
  for (const ext of SUPPORTED_EXTENSIONS) {
    const candidate = `${resolvedPath}${ext}`;
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function normalizePath(path: string): string {
  const cwd = process.cwd();
  return path.startsWith(cwd) ? path.slice(cwd.length + 1) : path;
}

function existsSync(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch (_error) {
    return false;
  }
}
