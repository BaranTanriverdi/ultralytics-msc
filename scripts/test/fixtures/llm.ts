export const MOCK_EXTRACTOR_RESPONSE = {
  facts: [
    {
      jsonPath: "$.ai.engine",
      jsonPointer: "/ai/engine",
      proposedValue: "Mock Engine (PyTorch)",
      source: { kind: "extracted" },
      repoSources: [{ path: "src/main.py", startLine: 1, endLine: 1, commit: "HEAD" }],
      confidence: 1.0,
      gate: "OK"
    }
  ]
};

export const MOCK_REASONER_RESPONSE = {
  facts: [
    {
      jsonPath: "$.ai.engine",
      jsonPointer: "/ai/engine",
      proposedValue: "Mock Engine (PyTorch)",
      source: { kind: "extracted" },
      repoSources: [{ path: "src/main.py", startLine: 1, endLine: 1, commit: "HEAD" }],
      confidence: 1.0,
      gate: "OK"
    }
  ],
  mutatedCard: {
    ai: {
      engine: "Mock Engine (PyTorch)"
    }
  },
  thinking: "Mock reasoning applied."
};

export const MOCK_VERIFIER_RESPONSE = {
  valid: true,
  critique: "Mock verification passed.",
  score: 10
};
