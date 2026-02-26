import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";

import { runExtractorPass } from "../src/llm/extractor.js";
import { runReasonerPass } from "../src/llm/reasoner.js";
import { MOCK_EXTRACTOR_RESPONSE, MOCK_REASONER_RESPONSE } from "../src/llm/mock_data.js";
import type { PassContext } from "../src/llm/types.js";
import { DEFAULT_LLM_SETTINGS, DEFAULT_RATE_LIMITS } from "../src/constants.js";

// Mock the LLM client
vi.mock("../src/llm/client.js", () => ({
  invokeChatCompletion: vi.fn()
}));

import { invokeChatCompletion } from "../src/llm/client.js";

describe("LLM Pipeline Integration", () => {
  const mockContext: PassContext = {
    runId: "test-run-id",
    baselineCard: {
      meta: { title: "Original Title", status: "draft", created: "2023-01-01", lastUpdated: "2023-01-01" },
      business: { useCase: "", intendedUse: "", nonGoals: [], targetAudience: [] },
      data: { sensitivity: "public", collection: [], handling: [] },
      model: { type: "rule-based", architecture: "", training: [] },
      safety: { safeguards: [], limitations: [] },
      compliance: { gdpr: false, hipaa: false }
    } as any, // Cast to any to avoid full CardSeed shape if complex
    analysis: {
      metadata: {
        runId: "test-run-id",
        baseSha: "BASE",
        headSha: "HEAD",
        generatedAt: "2023-01-01T00:00:00Z",
        cacheDigest: "digest"
      },
      fileEvidence: [],
      changedFiles: ["README.md"],
      repository: {
        anchorMap: {},
        headSha: "HEAD",
        runId: "test-run-id",
        useCase: "Test Use Case",
        intendedUse: "Test Intended Use",
        nonGoals: [],
        outOfScopeUse: [],
        repositoryUrl: "https://github.com/owner/repo",
        languages: ["TypeScript"],
        entrypoints: ["src/index.ts"],
        components: [],
        dependencyHighlights: [],
        testsPresent: true,
        coverageHint: null,
        problemSummary: "",
        userPopulations: [],
        dataFlow: [],
        governancePolicies: []
      } as any
    } as any,
    runtime: {
      enabled: true,
      dryRun: false,
      cacheEnabled: false,
      provider: "openai",
      model: "gpt-5.1",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      privacyMode: false,
      sampling: DEFAULT_LLM_SETTINGS,
      rateLimits: DEFAULT_RATE_LIMITS
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs extractor pass with mocked LLM response", async () => {
    // Setup mock response
    (invokeChatCompletion as any).mockResolvedValue({
      content: JSON.stringify(MOCK_EXTRACTOR_RESPONSE),
      raw: {},
      mode: "network",
      promptTokens: 100,
      completionTokens: 50,
      latencyMs: 200,
      requestDigest: "req-digest",
      responseDigest: "res-digest"
    });

    const result = await runExtractorPass(mockContext);

    const titleFact = result.facts.find((f) => f.jsonPath === "$.ai.engine");
    expect(titleFact).toBeDefined();
    expect(titleFact?.proposedValue).toBe("Mock Engine (PyTorch)");
    expect(invokeChatCompletion).toHaveBeenCalledTimes(1);

    // Verify JSON mode was enabled
    const callArgs = (invokeChatCompletion as any).mock.calls[0][1];
    expect(callArgs.jsonMode).toBe(true);
  });

  it("runs reasoner pass using extractor output", async () => {
    // Setup mock response for reasoner
    (invokeChatCompletion as any).mockResolvedValue({
      content: JSON.stringify(MOCK_REASONER_RESPONSE),
      raw: {},
      mode: "network",
      promptTokens: 100,
      completionTokens: 50,
      latencyMs: 200,
      requestDigest: "req-digest",
      responseDigest: "res-digest"
    });

    const extractorResult = {
      facts: MOCK_EXTRACTOR_RESPONSE.facts,
      artifactPath: "path/to/artifact",
      artifactDigest: "digest",
      promptId: "extractor.v1",
      mode: "network",
      metrics: { promptTokens: 0, completionTokens: 0, latencyMs: 0 },
      llm: null,
      attempts: 1,
      retryReasons: []
    };

    const result = await runReasonerPass(mockContext, extractorResult as any);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].gate).toBe("OK");
    expect(invokeChatCompletion).toHaveBeenCalledTimes(1);

    // Verify JSON mode was enabled
    const callArgs = (invokeChatCompletion as any).mock.calls[0][1];
    expect(callArgs.jsonMode).toBe(true);

  }, 120000);

  it("handles malformed JSON gracefully", async () => {
    (invokeChatCompletion as any).mockResolvedValue({
      content: "{ invalid json",
      raw: {},
      mode: "network",
      promptTokens: 100,
      completionTokens: 50,
      latencyMs: 200,
      requestDigest: "req-digest",
      responseDigest: "res-digest"
    });

    const result = await runExtractorPass(mockContext);

    // Should fall back to deterministic facts (which are empty in this mock context except for what runDeterministicPipeline produces)
    // Since we didn't mock runDeterministicPipeline, it runs with the mock context.
    // The mock context has some basic data, so deterministic pipeline might produce some facts.
    // But crucially, it shouldn't crash.
    expect(result.mode).toBe("deterministic");
  });
});
