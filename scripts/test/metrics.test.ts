import { describe, it, expect, vi } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// We can test the leaf path enumeration logic here
function isLeaf(value: any): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object") return true;
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return Object.keys(value).length === 0;
}

function getLeafNodes(obj: any, currentPath: string = "$"): {path: string, value: any}[] {
  let nodes: {path: string, value: any}[] = [];
  if (isLeaf(obj)) {
    nodes.push({path: currentPath, value: obj});
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      nodes = nodes.concat(getLeafNodes(obj[i], `${currentPath}[${i}]`));
    }
  } else if (typeof obj === "object") {
    for (const key in obj) {
      const nextPath = /^[a-zA-Z0-9_]+$/.test(key) ? `${currentPath}.${key}` : `${currentPath}["${key}"]`;
      nodes = nodes.concat(getLeafNodes(obj[key], nextPath));
    }
  }
  return nodes;
}

function checkAnchorResolvability(anchor: any, sha: string, mockExecSync?: any): boolean {
  const exec = mockExecSync || execSync;
  try {
    exec(`git cat-file -e ${sha}:${anchor.path}`, { stdio: "ignore" });
    const blob = exec(`git cat-file -p ${sha}:${anchor.path}`, { encoding: "utf-8" });
    const lines = blob.split("\n");
    if (anchor.startLine > 0 && anchor.endLine <= lines.length) {
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function parseDiffLines(diffStat: string) {
  if (!diffStat) return { added: 0, removed: 0 };
  const parts = diffStat.trim().split(/\s+/);
  if (parts.length >= 2) {
    return {
      added: parseInt(parts[0], 10),
      removed: parseInt(parts[1], 10)
    };
  }
  return { added: 0, removed: 0 };
}

function parseExpectedSections(changedPaths: string[], expectedSections: string[]) {
  const touched_sections = new Set<string>();
  for (const p of changedPaths) {
    const match = p.match(/^\$\.([^.\[]+)/);
    if (match) {
      touched_sections.add(match[1]);
    }
  }
  const touchedArray = Array.from(touched_sections);
  const hitCount = expectedSections.filter((s: string) => touched_sections.has(s)).length;
  const off_target_sections = touchedArray.filter(s => !expectedSections.includes(s));

  return {
    touched: touchedArray,
    hitCount,
    offTarget: off_target_sections
  };
}

describe("Metrics Utils", () => {
  it("should correctly identify leaf paths", () => {
    const obj = {
      a: 1,
      b: {
        c: 2,
        d: [3, 4],
        e: [],
        f: {}
      }
    };

    const nodes = getLeafNodes(obj);
    const paths = nodes.map(n => n.path);
    expect(paths).toContain("$.a");
    expect(paths).toContain("$.b.c");
    expect(paths).toContain("$.b.d[0]");
    expect(paths).toContain("$.b.d[1]");
    expect(paths).toContain("$.b.e");
    expect(paths).toContain("$.b.f");
  });

  it("should check anchor resolvability", () => {
    const mockExecSync = vi.fn((cmd: string) => {
      if (cmd.includes("-e")) return; // success
      if (cmd.includes("-p")) return "line1\nline2\nline3\nline4";
      throw new Error("Unknown command");
    });

    const validAnchor = { path: "test.txt", startLine: 1, endLine: 3 };
    expect(checkAnchorResolvability(validAnchor, "HEAD", mockExecSync)).toBe(true);

    const invalidAnchor = { path: "test.txt", startLine: 1, endLine: 10 };
    expect(checkAnchorResolvability(invalidAnchor, "HEAD", mockExecSync)).toBe(false);
  });

  it("should parse diff lines", () => {
    const diffStat = "15\t5\tdocs/ml_system_card.yaml";
    const result = parseDiffLines(diffStat);
    expect(result.added).toBe(15);
    expect(result.removed).toBe(5);
  });

  it("should parse expected sections from changed paths", () => {
    const changedPaths = [
      "$.integration.status",
      "$.provenance.source",
      "$.metrics.accuracy"
    ];
    const expectedSections = ["integration", "provenance"];

    const result = parseExpectedSections(changedPaths, expectedSections);
    expect(result.touched).toEqual(["integration", "provenance", "metrics"]);
    expect(result.hitCount).toBe(2);
    expect(result.offTarget).toEqual(["metrics"]);
  });
});
