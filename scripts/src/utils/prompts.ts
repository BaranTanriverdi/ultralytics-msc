import { readFile } from "node:fs/promises";

import { load } from "js-yaml";

export interface PromptTemplate {
  id: string;
  metadata: Record<string, unknown>;
  body: string;
}

const PROMPTS_DIR = new URL("../../prompts/", import.meta.url);

export async function loadPromptTemplate(relativePath: string): Promise<PromptTemplate> {
  const url = new URL(relativePath, PROMPTS_DIR);
  const raw = await readFile(url, "utf8");
  const match = raw.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`Prompt ${relativePath} is missing front matter`);
  }
  const metadata = (load(match[1]) ?? {}) as Record<string, unknown>;
  const body = match[2].trim();
  const id = typeof metadata.id === "string" ? metadata.id : relativePath.replace(/\.md$/, "");
  return { id, metadata, body };
}

export async function readAllPromptTemplates(): Promise<PromptTemplate[]> {
  return Promise.all([
    loadPromptTemplate("extractor.v1.md"),
    loadPromptTemplate("reasoner.v1.md"),
    loadPromptTemplate("notes.v1.md")
  ]);
}
