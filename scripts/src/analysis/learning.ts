import { join } from "node:path";
import { promises as fs } from "node:fs";

export async function loadProjectContext(): Promise<string> {
    try {
        const contexts = await Promise.all([
            readIfExists("docs/project_context.md"),
            readIfExists("docs/LEARNINGS.md"),
            readIfExists(".github/ml_system_card_instructions.md")
        ]);
        return contexts.filter(Boolean).join("\n\n");
    } catch {
        return "";
    }
}

async function readIfExists(path: string): Promise<string> {
    try {
        return await fs.readFile(path, "utf8");
    } catch {
        return "";
    }
}
