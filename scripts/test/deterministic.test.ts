import { describe, expect, it } from "vitest";

import {
  normalizeCard,
  stringifyDeterministic,
  ensureTrailingNewline,
  ensureLf,
  computeSha256,
  normalizeAnchorsIndex,
} from "../src/card/deterministic.js";

import type { AnchorsIndex } from "lib/card/types.js";

describe("normalizeCard", () => {
  it("sorts arrays with domain-specific comparators and normalizes values", () => {
    const card = {
      governance: {
        riskRegister: [
          { item: "Insufficient tests", likelihood: 0.2, impact: 0.6 },
          { item: "Model drift", likelihood: 0.6, impact: 0.9 },
        ],
      },
      mlCore: {
        metrics: [
          { metric: "latency", slice: "p95", value: 600 },
          { metric: "accuracy", slice: "overall", value: 0.92341 },
        ],
      },
      telemetry: {
        jitter: [0.0001234, Number.POSITIVE_INFINITY, -0.0045678, 0],
      },
      lastUpdated: "2025-11-09T10:32:15.456-05:00",
      tags: ["zeta", "alpha"],
    };

    const normalized = normalizeCard(card);

    expect(normalized.governance.riskRegister[0]?.item).toBe("Model drift");
    expect(normalized.governance.riskRegister[1]?.item).toBe("Insufficient tests");

    expect(normalized.mlCore.metrics[0]?.metric).toBe("accuracy");
    expect(normalized.mlCore.metrics[1]?.metric).toBe("latency");

    expect(normalized.telemetry.jitter).toEqual([0.000123, null, -0.00457, 0]);
    expect(normalized.lastUpdated).toBe("2025-11-09T15:32:15.456Z");
  expect(normalized.tags).toEqual(["zeta", "alpha"]);
  });
});

describe("stringify utilities", () => {
  it("produces stable YAML with LF endings and trailing newline", () => {
    const yaml = stringifyDeterministic({ alpha: 1, beta: 2 });
    expect(yaml.endsWith("\n")).toBe(true);
    expect(yaml).not.toContain("\r\n");
  });

  it("enforces LF endings and trailing newline explicitly", () => {
    expect(ensureLf("a\r\nb")).toBe("a\nb");
    expect(ensureTrailingNewline("abc")).toBe("abc\n");
    expect(ensureTrailingNewline("abc\n")).toBe("abc\n");
  });

  it("computes a deterministic SHA-256 hash", () => {
    expect(computeSha256("deterministic"))
      .toBe("0badac3c6df445ad3aea62da1350683923aba37c685978afed96a515d12921a3");
  });
});

describe("normalizeAnchorsIndex", () => {
  it("sorts anchors by jsonPath and anchor tuple", () => {
    const index: AnchorsIndex = {
      $schema: "schema",
      version: "1",
      cardSha: "abc",
      runId: "run-1",
      generatedAt: "2025-11-09T00:00:00.000Z",
      anchorsByPath: {
        "b.path": [
          { path: "src/z.ts", startLine: 20, endLine: 30, commit: "b" },
          { path: "src/a.ts", startLine: 5, endLine: 10, commit: "a" },
        ],
        "a.path": [
          { path: "src/c.ts", startLine: 1, endLine: 4, commit: "c" },
        ],
      },
    };

    const normalized = normalizeAnchorsIndex(index);

    expect(Object.keys(normalized.anchorsByPath)).toEqual(["a.path", "b.path"]);
    expect(normalized.anchorsByPath["b.path"][0]?.path).toBe("src/a.ts");
    expect(normalized.anchorsByPath["b.path"][1]?.path).toBe("src/z.ts");
  });
});
