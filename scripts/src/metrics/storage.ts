import * as fs from "fs";
import * as path from "path";
import { MetricsReport } from "./types.js";

export function getMetricsPath(runId: string): string {
  return path.join(process.cwd(), "docs", ".metrics", `${runId}.metrics.json`);
}

export function readMetrics(runId: string): MetricsReport {
  const p = getMetricsPath(runId);
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as MetricsReport;
    } catch (e) {
      console.error(`Failed to read metrics file ${p}`, e);
    }
  }
  return {
    metrics_schema_version: "1.0.0",
    runId,
  };
}

export function writeMetrics(runId: string, metrics: Partial<MetricsReport>): void {
  const p = getMetricsPath(runId);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const existing = readMetrics(runId);
  const updated = { ...existing, ...metrics };

  fs.writeFileSync(p, JSON.stringify(updated, null, 2), "utf-8");
}
