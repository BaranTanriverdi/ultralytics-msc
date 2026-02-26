import { join, extname, basename } from "node:path";
import { promises as fs } from "node:fs";

import { load } from "js-yaml";
import { glob } from "glob";

import type { Anchor } from "lib/card/types.js";

import { exec } from "../utils/exec.js";
import { logger } from "../utils/logger.js";

export interface RepositoryInsights {
  runId: string;
  headSha: string;
  useCase: string;
  intendedUse: string;
  nonGoals: string[];
  outOfScopeUse: string[];
  repositoryUrl: string | null;
  languages: string[];
  entrypoints: string[];
  components: Array<{ name: string; summary: string; keyFiles: string[] }>;
  dependencyHighlights: string[];
  testsPresent: boolean;
  coverageHint: string | null;
  problemSummary: string;
  userPopulations: string[];
  dataFlow: string[];
  governancePolicies: string[];
  anchorMap: Record<string, Array<Omit<Anchor, "commit">>>;
}

export async function buildRepositoryInsights(input: {
  runId: string;
  headSha: string;
}): Promise<RepositoryInsights> {
  const rootDir = process.cwd();

  // README Analysis
  const readmePath = await findReadme(rootDir);
  const readmeContent = readmePath ? await fs.readFile(readmePath, "utf8") : "";
  const readmeLines = readmeContent.split("\n");

  const anchorMap: Record<string, Array<Omit<Anchor, "commit">>> = {};
  if (readmePath) {
      const rp = basename(readmePath); // Relative path usually README.md
      analyzeReadmeSections(rp, readmeLines, anchorMap);
      await analyzeReadmeCodeRefs(rp, readmeLines, anchorMap);
  }

  // Codebase Analysis (Polyglot)
  const codeStats = await analyzeCodebase(rootDir);

  // Dependency Analysis
  const dependencies = await collectPolyglotDependencies(rootDir);
  if (dependencies.highlights.length > 0) {
      // Find where these deps are defined for anchoring
      for (const file of dependencies.files) {
          if (file.endsWith("package.json")) {
             anchorMap["CODE#deps"] = [ ...(anchorMap["CODE#deps"] || []), await anchorForFile(file, "dependencies") ].filter(notNull);
          } else if (file.endsWith("requirements.txt") || file.endsWith("environment.yaml") || file.endsWith("setup.py")) {
              // Anchor to the first highlight found in this file
              for (const dep of dependencies.highlights) {
                  const a = await anchorForFile(file, dep);
                  if (a) {
                      anchorMap["CODE#deps"] = [ ...(anchorMap["CODE#deps"] || []), a ];
                      break;
                  }
              }
          }
      }
  }

  // Component Analysis
  const components = await identifyComponents(rootDir, codeStats.files);
  for (const comp of components) {
      if (comp.keyFiles.length > 0) {
          const a = await anchorForFile(comp.keyFiles[0], ""); // Just file existence anchor
          if (a) {
               anchorMap["CODE#components"] = [ ...(anchorMap["CODE#components"] || []), a ];
          }
      }
  }

  // YAML Overrides
  const stakeholderYamlRoles = await readStakeholderTitles();
  if (stakeholderYamlRoles.length > 0) {
    anchorMap["docs/stakeholders.yaml#titles"] = [ await anchorForFile("docs/stakeholders.yaml", "title:") ].filter(notNull);
  }

  const useCase = "To be determined from repository analysis.";
  const intendedUse = "To be determined from repository analysis.";
  const problemSummary = "To be determined from repository analysis.";

  const repositoryUrl = await resolveRepositoryUrl();
  if (repositoryUrl && readmePath) {
    const urlLine = readmeLines.findIndex(l => l.includes(repositoryUrl));
    if (urlLine >= 0) {
      anchorMap["README.md#repo-link"] = [anchorForLine(basename(readmePath), urlLine + 1)];
    }
  }

  return {
    ...input,
    useCase,
    intendedUse,
    nonGoals: extractSectionList(readmeLines, anchorMap["README.md#out-of-scope"]?.[0]?.startLine),
    outOfScopeUse: extractSectionList(readmeLines, anchorMap["README.md#out-of-scope"]?.[0]?.startLine),
    repositoryUrl,
    languages: codeStats.languages,
    entrypoints: components.filter(c => c.name.toLowerCase().includes("entry") || c.name.toLowerCase().includes("main")).map(c => c.keyFiles[0] || ""),
    components,
    dependencyHighlights: dependencies.highlights,
    testsPresent: codeStats.testsPresent,
    coverageHint: codeStats.testsPresent ? "Tests detected in repository structure." : null,
    problemSummary,
    userPopulations: stakeholderYamlRoles.length > 0 ? stakeholderYamlRoles : extractSectionList(readmeLines, anchorMap["README.md#stakeholders"]?.[0]?.startLine),
    dataFlow: extractSectionList(readmeLines, anchorMap["README.md#workflow"]?.[0]?.startLine),
    governancePolicies: extractAutoMergePolicies(readmeContent),
    anchorMap
  };
}

// --- Helpers ---

function notNull<T>(val: T | null | undefined): val is T {
    return val !== null && val !== undefined;
}

async function findReadme(root: string): Promise<string | null> {
    const candidates = ["README.md", "readme.md", "README.rst", "README.txt"];
    for (const c of candidates) {
        if (await fs.stat(join(root, c)).catch(() => false)) return c;
    }
    return null;
}

function analyzeReadmeSections(path: string, lines: string[], anchorMap: Record<string, Omit<Anchor, "commit">[]>) {
    const headers = lines.map((text, i) => ({ text, line: i + 1 })).filter(h => h.text.startsWith("#"));
    const find = (req: RegExp[]) => headers.find(h => req.some(r => r.test(h.text)));

    const mapping = {
        "README.md#title": [/^#\s+.+/],
        "README.md#scope": [/^##\s+Scope/i, /^##\s+In\s+Scope/i, /^##\s+Goals/i],
        "README.md#out-of-scope": [/^##\s+Out\s+of\s+Scope/i, /^##\s+Non[-\s]Goals/i],
        "README.md#stakeholders": [/^##\s+Stakeholders/i, /^##\s+Users/i],
        "README.md#workflow": [/^##\s+Workflow/i, /^##\s+Process/i, /^##\s+Architecture/i]
    };

    for (const [key, patterns] of Object.entries(mapping)) {
        const h = find(patterns);
        if (h) anchorMap[key] = [anchorForLine(path, h.line)];
    }
}

async function analyzeReadmeCodeRefs(_path: string, _lines: string[], _anchorMap: Record<string, Omit<Anchor, "commit">[]>) {
    // Placeholder: Future enhancement to find links to code in README
}

async function analyzeCodebase(root: string): Promise<{ languages: string[], files: string[], testsPresent: boolean }> {
    // Scan for files (limit depth to avoid node_modules madness if not ignored)
    const files = await glob("**/*", {
        cwd: root,
        ignore: [
            "**/node_modules/**", "**/.git/**", "dist/**", "build/**", "coverage/**", "**/.DS_Store",
            // MSC infrastructure – must not be treated as project code
            "scripts/**", ".msc/**", "lib/card/**", "lib/*.schema.json",
            "lib/tsconfig.base.json", "docs/prototype_card.*",
            ".github/workflows/generator.yml", ".github/workflows/apply.yml", ".github/workflows/ci.yml"
        ],
        nodir: true,
        maxDepth: 5
    });

    const exts = new Set(files.map(f => extname(f)));
    const languages = new Set<string>();

    if (exts.has(".ts") || exts.has(".tsx")) languages.add("TypeScript");
    if (exts.has(".js") || exts.has(".jsx")) languages.add("JavaScript");
    if (exts.has(".py")) languages.add("Python");
    if (exts.has(".ipynb")) languages.add("Jupyter Notebook");
    if (exts.has(".java")) languages.add("Java");
    if (exts.has(".R")) languages.add("R");
    if (exts.has(".rs")) languages.add("Rust");
    if (exts.has(".go")) languages.add("Go");

    const testsPresent = files.some(f =>
        f.includes("test") ||
        f.includes("spec") ||
        f.endsWith("conftest.py") ||
        f.endsWith("pytest.ini")
    );

    return { languages: Array.from(languages), files, testsPresent };
}

async function collectPolyglotDependencies(root: string): Promise<{ highlights: string[], files: string[] }> {
    const highlights = new Set<string>();
    const files = [];

    // Python: requirements.txt
    if (await fs.stat(join(root, "requirements.txt")).catch(() => false)) {
        files.push("requirements.txt");
        const content = await fs.readFile("requirements.txt", "utf8");
        content.split("\n").forEach(l => {
            const name = l.split(/[=<>]/)[0].trim();
            if (isSignificantDep(name)) highlights.add(name);
        });
    }

    // Python: environment.yaml (Conda)
    if (await fs.stat(join(root, "environment.yaml")).catch(() => false)) {
        files.push("environment.yaml");
        try {
            const content = await fs.readFile(join(root, "environment.yaml"), "utf8");
            if (content.includes("dependencies:")) {
                // Extremely naive parsing to avoid pulling in a full yaml parser if strictly regex based,
                // but since we have js-yaml, let's use it safely.
                const doc = load(content) as any;
                const deps = doc.dependencies || [];
                deps.forEach((d: any) => {
                    if (typeof d === "string") {
                        const name = d.split(/[=<>]/)[0].trim();
                        if (isSignificantDep(name)) highlights.add(name);
                    } else if (typeof d === "object" && d.pip) {
                        d.pip.forEach((p: string) => {
                             const name = p.split(/[=<>]/)[0].trim();
                             if (isSignificantDep(name)) highlights.add(name);
                        });
                    }
                });
            }
        } catch (e) { logger.warn("Failed to parse environment.yaml", { error: e }); }
    }

    // Node: package.json
    const packageJsons = await glob("**/package.json", { cwd: root, ignore: ["**/node_modules/**", "scripts/**"], maxDepth: 3 });
    for (const pj of packageJsons) {
        files.push(pj);
        try {
            const content = await fs.readFile(pj, "utf8");
            const json = JSON.parse(content);
            const allDeps = { ...json.dependencies, ...json.devDependencies };
            Object.keys(allDeps).forEach(d => {
                if (isSignificantDep(d)) highlights.add(d);
            });
        } catch {}
    }

    // Python: setup.py (Naive regex)
    if (await fs.stat(join(root, "setup.py")).catch(() => false)) {
        files.push("setup.py");
        const content = await fs.readFile("setup.py", "utf8");
        if (content.includes("install_requires")) {
             // Heuristic: Just report that we found setup.py dependencies
             highlights.add("setup.py dependencies");
        }
    }

    return { highlights: Array.from(highlights), files };
}

function isSignificantDep(name: string): boolean {
    const SIG = [
        "torch", "tensorflow", "keras", "scikit-learn", "sklearn", "pandas", "numpy", "matplotlib", "seaborn",
        "xgboost", "lightgbm", "catboost", "fastai", "flax", "jax", "spacy", "nltk", "transformers", "huggingface",
        "wandb", "mlflow", "streamlit", "gradio", "dash", "shiny",
        "react", "next", "vue", "angular", "svelte"
    ];
    return SIG.some(s => name.toLowerCase().includes(s));
}

async function identifyComponents(root: string, files: string[]): Promise<Array<{ name: string; summary: string; keyFiles: string[] }>> {
    const components: Array<{ name: string; summary: string; keyFiles: string[] }> = [];

    // Jupyter Notebooks
    const notebooks = files.filter(f => f.endsWith(".ipynb"));
    notebooks.forEach(nb => {
        components.push({
            name: basename(nb, ".ipynb"),
            summary: "Jupyter Notebook Experiment/Analysis",
            keyFiles: [nb]
        });
    });

    // Python Scripts (Top level or src/)
    const pyScripts = files.filter(f => f.endsWith(".py") && (f.split("/").length <= 2 || f.startsWith("src/")));
    pyScripts.forEach(py => {
        if (basename(py) === "setup.py" || basename(py) === "conftest.py") return;
        components.push({
            name: basename(py, ".py"),
            summary: "Python Script Module",
            keyFiles: [py]
        });
    });

    // Next.js Pages (Heuristic)
    const nextPages = files.filter(f => f.match(/app\/.*\/page\.tsx$/));
    nextPages.forEach(p => {
        const parts = p.split("/");
        const name = parts[parts.length - 2] === "app" ? "Home Page" : `Page: ${parts[parts.length - 2]}`;
        components.push({
            name: name,
            summary: "Next.js UI Route",
            keyFiles: [p]
        });
    });

    return components;
}

// --- Common Utils ---

function anchorForLine(path: string, line: number): Omit<Anchor, "commit"> {
  return { path, startLine: line, endLine: line, kind: "docs" };
}

async function anchorForFile(path: string, search: string): Promise<Omit<Anchor, "commit"> | null> {
  try {
    const content = await fs.readFile(path, "utf8");
    const lines = content.split("\n");
    const index = lines.findIndex((line) => line.includes(search));
    const lineNumber = index >= 0 ? index + 1 : 1;
    const kind = path.match(/\.(ts|tsx|js|py|java|go|rs|cpp|h)$/) ? "code" : "config";
    return { path, startLine: lineNumber, endLine: lineNumber, kind };
  } catch {
    return null;
  }
}

function extractSectionList(lines: string[], startLine: number | undefined): string[] {
  if (!startLine) return [];
  const result: string[] = [];
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#")) break;
    if (line.trim().startsWith("-") || line.trim().startsWith("*")) {
      result.push(line.replace(/^[\-\*]\s*/, "").trim());
    }
  }
  return result;
}

function extractAutoMergePolicies(readme: string): string[] {
  const match = readme.match(/\*\*Auto-merge:\*\*\s*(.+)/i);
  return match && match[1] ? [match[1].replace(/\*\*/g, "").trim()] : [];
}

async function readStakeholderTitles(): Promise<string[]> {
  try {
    if (!await fs.stat("docs/stakeholders.yaml").catch(() => false)) return [];
    const raw = await fs.readFile("docs/stakeholders.yaml", "utf8");
    const parsed = load(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((e: any) => (e?.title ?? e?.id ?? "").trim()).filter(Boolean);
  } catch { return []; }
}

async function resolveRepositoryUrl(): Promise<string | null> {
  if (process.env.GITHUB_REPOSITORY) return `https://github.com/${process.env.GITHUB_REPOSITORY}`;
  try {
    const { stdout } = await exec("git", ["remote", "get-url", "origin"]);
    const url = stdout.trim();
    if (url.startsWith("git@")) {
      const match = url.match(/git@(.+):(.+)/);
      if (match) return `https://${match[1]}/${match[2].replace(/\.git$/, "")}`;
    }
    return url.replace(/\.git$/, "") || null;
  } catch { return null; }
}
