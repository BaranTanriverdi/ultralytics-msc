import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

export function runFaithfulnessSampler(runId: string, headSha: string, sampleSize: number = 10) {
  const docsDir = path.join(process.cwd(), "docs");
  const proposalPath = path.join(docsDir, ".proposals", `${runId}.json`);
  const decisionsPath = path.join(docsDir, ".proposals", `${runId}.decisions.json`);

  if (!fs.existsSync(proposalPath) || !fs.existsSync(decisionsPath)) {
    console.warn("Proposal or decisions file missing, cannot run sampler.");
    return;
  }

  const proposalData = JSON.parse(fs.readFileSync(proposalPath, "utf-8"));
  const decisionsData = JSON.parse(fs.readFileSync(decisionsPath, "utf-8"));

  // Build a map from BOTH proposal.facts (low-confidence / rejected rows)
  // AND confidence_report (all rows including accepted ones).
  // confidence_report is the authoritative source for accepted facts;
  // proposal.facts only contains rows that were gate-rejected.
  const factsMap = new Map();
  for (const fact of proposalData.facts || []) {
    factsMap.set(fact.jsonPath, fact);
  }
  for (const row of proposalData.confidence_report || []) {
    if (!factsMap.has(row.jsonPath)) {
      factsMap.set(row.jsonPath, {
        jsonPath: row.jsonPath,
        source: { kind: row.kind },
        confidence: row.confidence,
        gate: row.gate,
        repoSources: (row.sources || []).map((s: string) => {
          const m = s.match(/^(.+?)#L(\d+)-L(\d+)$/);
          return m
            ? { path: m[1], startLine: parseInt(m[2], 10), endLine: parseInt(m[3], 10) }
            : { path: s, startLine: 1, endLine: 1 };
        }),
      });
    }
  }

  const acceptedFacts = [];
  for (const decision of decisionsData.decisions || []) {
    if (decision.decision === "accept" || decision.decision === "edit") {
      const fact = factsMap.get(decision.jsonPath);
      if (fact) {
        acceptedFacts.push({
          jsonPath: decision.jsonPath,
          acceptedValue: decision.decision === "edit" ? decision.editedValue : fact.proposedValue,
          sourceKind: fact.source?.kind,
          gate: fact.gate,
          anchors: fact.repoSources || [],
        });
      }
    }
  }

  // Deterministic sampling: sort by jsonPath
  acceptedFacts.sort((a, b) => a.jsonPath.localeCompare(b.jsonPath));

  const sample = acceptedFacts.slice(0, sampleSize).map(fact => {
    const resolvedAnchors = fact.anchors.map((anchor: any) => {
      let snippet = "";
      try {
        const blob = execSync(`git cat-file -p ${headSha}:${anchor.path}`, { encoding: "utf-8" });
        const lines = blob.split("\n");
        if (anchor.startLine > 0 && anchor.endLine <= lines.length) {
          snippet = lines.slice(anchor.startLine - 1, anchor.endLine).join("\n");
        } else {
          snippet = "[UNRESOLVABLE_LINE_RANGE]";
        }
      } catch (e) {
        snippet = "[UNRESOLVABLE_FILE]";
      }
      return {
        path: anchor.path,
        startLine: anchor.startLine,
        endLine: anchor.endLine,
        snippet,
      };
    });

    return {
      jsonPath: fact.jsonPath,
      acceptedValue: fact.acceptedValue,
      sourceKind: fact.sourceKind,
      gate: fact.gate,
      resolvedAnchors,
    };
  });

  const outPath = path.join(docsDir, ".metrics", `${runId}.faithfulness_sample.json`);
  fs.writeFileSync(outPath, JSON.stringify(sample, null, 2), "utf-8");
  console.log(`Faithfulness sample written to ${outPath}`);
}
