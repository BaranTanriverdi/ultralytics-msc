import * as fs from "fs";
import * as path from "path";
import { MetricsReport } from "./types.js";

export function runAggregateStage() {
  const metricsDir = path.join(process.cwd(), "docs", ".metrics");
  if (!fs.existsSync(metricsDir)) {
    console.warn(`Metrics directory not found: ${metricsDir}`);
    return;
  }

  const files = fs.readdirSync(metricsDir).filter(f => f.endsWith(".metrics.json"));
  const reports: MetricsReport[] = [];

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(metricsDir, file), "utf-8"));
      reports.push(data);
    } catch (e) {
      console.error(`Failed to parse ${file}`, e);
    }
  }

  const totalRuns = reports.length;
  if (totalRuns === 0) {
    console.log("No metrics reports found to aggregate.");
    return;
  }

  const successfulRuns = reports.filter(r => r.apply_success === 1);
  const schemaValidRuns = reports.filter(r => r.schema_valid === 1);

  const summary = {
    total_runs: totalRuns,
    successful_runs: successfulRuns.length,
    schema_valid_runs: schemaValidRuns.length,
    schema_validity_rate: schemaValidRuns.length / totalRuns,
    apply_success_rate: successfulRuns.length / totalRuns,

    averages: {
      facts_total: avg(reports, "facts_total"),
      anchor_compliance_accepted_nontrivial: avg(successfulRuns, "anchor_compliance_accepted_nontrivial"),
      anchor_resolvability_rate_accepted: avg(successfulRuns, "anchor_resolvability_rate_accepted"),
      anchored_field_coverage_leaf: avg(successfulRuns, "anchored_field_coverage_leaf"),
      msc_diff_lines: avg(successfulRuns, "msc_diff_lines"),
      expected_section_hit_rate: avg(successfulRuns, "expected_section_hit_rate"),
      off_target_section_count: avg(successfulRuns, "off_target_section_count"),
      off_target_path_count: avg(successfulRuns, "off_target_path_count"),
      apply_attempts_until_success: avg(successfulRuns, "apply_attempts_until_success"),
    },

    blocked_reasons: countBy(reports.filter(r => r.apply_success === 0), "blocked_reason"),
  };

  const outPath = path.join(metricsDir, "summary.json");
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf-8");
  console.log(`Aggregated summary written to ${outPath}`);
}

function avg(reports: any[], key: string): number {
  const valid = reports.filter(r => typeof r[key] === "number");
  if (valid.length === 0) return 0;
  const sum = valid.reduce((acc, r) => acc + r[key], 0);
  return sum / valid.length;
}

function countBy(reports: any[], key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of reports) {
    const val = r[key] || "unknown";
    counts[val] = (counts[val] || 0) + 1;
  }
  return counts;
}

// If run directly
if (require.main === module) {
  runAggregateStage();
}
