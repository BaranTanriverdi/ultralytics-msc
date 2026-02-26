#!/usr/bin/env node
import { readFileAtCommit } from "../utils/git.js";
import { logger } from "../utils/logger.js";
import { inspectCardDiff } from "../analysis/diff_inspector.js";
import { CARD_PATH } from "../constants.js";
import { writeTextFile } from "../utils/fs.js";

interface ReporterArgs {
  baseRef: string;
  headRef: string;
  outputFile: string;
}

async function main(): Promise<void> {
  const args = parseArgs();
  logger.info("Generating Diff Report", { base: args.baseRef, head: args.headRef });

  const baseCard = await readFileAtCommit(CARD_PATH, args.baseRef);
  const headCard = await readFileAtCommit(CARD_PATH, args.headRef);

  if (!baseCard || !headCard) {
    logger.warn("Could not read card files for diff");
    return;
  }

  const report = inspectCardDiff(baseCard, headCard);
  const markdown = generateMarkdown(report, args);

  await writeTextFile(args.outputFile, markdown);
  logger.info("Report written", { path: args.outputFile });
}

function generateMarkdown(report: ReturnType<typeof inspectCardDiff>, args: ReporterArgs): string {
  if (report.isNoiseOnly) {
    return `### ⚠️ ML System Card: Formatting Changes Detected

The \`ml_system_card.yaml\` file has changed, but the content is **semantically identical**.
This means the changes are likely just reordering or formatting differences ("noise").

**Action Required:**
- Please run the deterministic formatter locally or revert the file to match the canonical output.
- This ensures the git history remains clean and readable.
`;
  }

  if (report.hasSemanticChanges) {
    const opCount = report.semanticChanges.length;
    const opsList = report.semanticChanges
      .slice(0, 10)
      .map(op => `- \`${op.op}\` **${op.path}**`)
      .join("\n");

    const more = opCount > 10 ? `\n\n*(...and ${opCount - 10} more)*` : "";

    return `### 📝 ML System Card: Semantic Updates

**${opCount}** semantic changes detected.

${opsList}${more}

<details>
<summary>View Full JSON Patch</summary>

\`\`\`json
${JSON.stringify(report.semanticChanges, null, 2)}
\`\`\`

</details>
`;
  }

  return `### ✅ ML System Card: No Changes

The \`ml_system_card.yaml\` file is identical to the base branch.
`;
}

function parseArgs(): ReporterArgs {
  const argv = process.argv.slice(2);
  const args: Partial<ReporterArgs> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--base-ref") {
      args.baseRef = argv[++i];
    } else if (token === "--head-ref") {
      args.headRef = argv[++i];
    } else if (token === "--output") {
      args.outputFile = argv[++i];
    }
  }
  if (!args.baseRef || !args.headRef || !args.outputFile) {
    throw new Error("Usage: diff-reporter --base-ref <sha> --head-ref <sha> --output <file>");
  }
  return args as ReporterArgs;
}

void main().catch((error) => {
  logger.error("Failed to generate report", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
