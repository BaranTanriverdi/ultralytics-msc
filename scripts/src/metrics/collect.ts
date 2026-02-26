import { parseArgs } from "util";
import { runGeneratorStage } from "./stages/generator.js";
import { runDecisionsStage } from "./stages/decisions.js";
import { runApplyStage } from "./stages/apply.js";
import { runFaithfulnessSampler } from "./sampler.js";

async function main() {
  const { values } = parseArgs({
    options: {
      runId: { type: "string" },
      stage: { type: "string" },
      baseSha: { type: "string" },
      headSha: { type: "string" },
      sampleSize: { type: "string" },
      applyFailed: { type: "boolean" },
    },
  });

  const { runId, stage, baseSha, headSha, sampleSize, applyFailed } = values;

  if (!runId) {
    console.error("Missing --runId");
    process.exit(1);
  }

  if (!stage) {
    console.error("Missing --stage");
    process.exit(1);
  }

  try {
    switch (stage) {
      case "generator":
        await runGeneratorStage(runId);
        break;
      case "decisions":
        await runDecisionsStage(runId);
        break;
      case "apply":
        await runApplyStage(runId, baseSha, headSha, applyFailed);
        if (headSha && !applyFailed) {
          runFaithfulnessSampler(runId, headSha, sampleSize ? parseInt(sampleSize, 10) : 10);
        }
        break;
      default:
        console.error(`Unknown stage: ${stage}`);
        process.exit(1);
    }
    console.log(`Metrics collection for stage '${stage}' completed successfully.`);
  } catch (error) {
    console.error(`Error collecting metrics for stage '${stage}':`, error);
    process.exit(1);
  }
}

main().catch(console.error);
