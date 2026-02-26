import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAnchorsIndex } from "../src/write_anchors.js";
import { ANCHORS_SCHEMA, DEFAULT_ANCHORS_VERSION } from "../src/constants.js";

import type { Anchor, Fact } from "lib/card/types.js";

const baseAnchor: Anchor = {
  path: "src/card.ts",
  startLine: 10,
  endLine: 20,
  commit: "1234567",
};

const baseFact: Fact = {
  jsonPath: "mlCore.metrics[0].value",
  proposedValue: 0.95,
  source: { kind: "extracted" },
  repoSources: [baseAnchor],
  confidence: 0.9,
  gate: "OK",
};

describe("buildAnchorsIndex", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-11-09T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("filters forbidden paths, deduplicates anchors, and normalizes output", () => {
    const facts: Fact[] = [
      {
        ...baseFact,
        repoSources: [
          baseAnchor,
          { ...baseAnchor, path: "src/adapter.ts" },
          { ...baseAnchor, commit: "abcdef0", fingerprint: "abc" },
          { ...baseAnchor, path: "config/.env" },
        ],
      },
      {
        ...baseFact,
        jsonPath: "mlCore.metrics[1].value",
        repoSources: [
          { path: "docs/ref.md", startLine: 1, endLine: 5, commit: "7654321" },
          { path: "docs/ref.md", startLine: 1, endLine: 5, commit: "7654321" },
        ],
      },
      {
        ...baseFact,
        jsonPath: "integration.runtimeLatency",
        repoSources: [],
      },
    ];

    const index = buildAnchorsIndex(facts, { runId: "run-123", cardSha: "deadbeef" });

    expect(index.$schema).toBe(ANCHORS_SCHEMA);
    expect(index.version).toBe(DEFAULT_ANCHORS_VERSION);
    expect(index.generatedAt).toBe("2025-11-09T12:00:00.000Z");
    expect(Object.keys(index.anchorsByPath)).toEqual([
      "mlCore.metrics[0].value",
      "mlCore.metrics[1].value",
    ]);

    const firstPathAnchors = index.anchorsByPath["mlCore.metrics[0].value"];
    expect(firstPathAnchors).toHaveLength(3);
    expect(firstPathAnchors[0]).toMatchObject({ path: "src/adapter.ts" });
    expect(firstPathAnchors[1]).toMatchObject({ path: "src/card.ts", commit: "1234567" });
    expect(firstPathAnchors[2]).toMatchObject({ fingerprint: "abc", commit: "abcdef0" });

    const secondPathAnchors = index.anchorsByPath["mlCore.metrics[1].value"];
    expect(secondPathAnchors).toHaveLength(1);
    expect(secondPathAnchors[0]).toMatchObject({ path: "docs/ref.md" });
  });
});
