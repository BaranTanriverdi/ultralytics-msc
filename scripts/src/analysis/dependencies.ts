import { dirname } from "node:path";

import fsExtra from "fs-extra";

export interface DependencyGraphEdge {
  name: string;
  spec: string;
  kind: "runtime" | "dev" | "peer" | "optional";
}

export interface DependencyManifestSummary {
  runtime: number;
  dev: number;
  peer: number;
  optional: number;
  total: number;
}

export interface DependencyManifest {
  path: string;
  workspace: string;
  packageName: string | null;
  edges: DependencyGraphEdge[];
  summary: DependencyManifestSummary;
}

export interface DependencyGraph {
  manifests: DependencyManifest[];
  warnings: string[];
}

const CANDIDATE_MANIFESTS = [
  "package.json",
  "scripts/package.json",
  "app/package.json"
];

export async function collectDependencyGraph(): Promise<DependencyGraph> {
  const manifests: DependencyManifest[] = [];
  const warnings: string[] = [];

  for (const manifestPath of CANDIDATE_MANIFESTS) {
    try {
      if (!(await fsExtra.pathExists(manifestPath))) {
        continue;
      }
      const raw = await fsExtra.readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const packageName = typeof parsed.name === "string" ? parsed.name : null;

      const edges: DependencyGraphEdge[] = [];
      collectEdges(parsed, "dependencies", "runtime", edges);
      collectEdges(parsed, "devDependencies", "dev", edges);
      collectEdges(parsed, "peerDependencies", "peer", edges);
      collectEdges(parsed, "optionalDependencies", "optional", edges);

      edges.sort((a, b) => {
        if (a.kind === b.kind) {
          return a.name.localeCompare(b.name);
        }
        return kindWeight(a.kind) - kindWeight(b.kind);
      });

      const summary = summarize(edges);
      manifests.push({
        path: manifestPath,
        workspace: manifestWorkspace(manifestPath),
        packageName,
        edges,
        summary
      });
    } catch (error) {
      warnings.push(
        `Failed to process ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  manifests.sort((a, b) => a.path.localeCompare(b.path));

  return { manifests, warnings };
}

function collectEdges(
  parsed: Record<string, unknown>,
  property: string,
  kind: DependencyGraphEdge["kind"],
  edges: DependencyGraphEdge[]
): void {
  const section = parsed[property];
  if (!section || typeof section !== "object") {
    return;
  }
  const entries = Object.entries(section as Record<string, unknown>);
  for (const [name, value] of entries) {
    if (typeof value !== "string") {
      continue;
    }
    edges.push({ name, spec: value, kind });
  }
}

function summarize(edges: DependencyGraphEdge[]): DependencyManifestSummary {
  const summary: DependencyManifestSummary = { runtime: 0, dev: 0, peer: 0, optional: 0, total: 0 };
  for (const edge of edges) {
    summary[edge.kind] += 1;
    summary.total += 1;
  }
  return summary;
}

function manifestWorkspace(manifestPath: string): string {
  const directory = dirname(manifestPath);
  return directory === "." ? "root" : directory;
}

function kindWeight(kind: DependencyGraphEdge["kind"]): number {
  switch (kind) {
    case "runtime":
      return 0;
    case "dev":
      return 1;
    case "peer":
      return 2;
    case "optional":
      return 3;
    default:
      return 99;
  }
}
