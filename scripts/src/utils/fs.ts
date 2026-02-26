import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import fsExtra from "fs-extra";

import { ensureLf, ensureTrailingNewline } from "../card/deterministic.js";

export async function readTextFile(path: string): Promise<string | null> {
  try {
    const content = await fs.readFile(path, "utf8");
    return content;
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") {
      return null;
    }
    throw error;
  }
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await fsExtra.ensureDir(dirname(path));
  const normalized = ensureTrailingNewline(ensureLf(content));
  await fs.writeFile(path, normalized, "utf8");
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  const raw = await readTextFile(path);
  if (raw === null) {
    return null;
  }
  return JSON.parse(raw) as T;
}

export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await writeTextFile(path, `${content}\n`);
}

export async function removeIfExists(path: string): Promise<void> {
  await fsExtra.remove(path);
}
