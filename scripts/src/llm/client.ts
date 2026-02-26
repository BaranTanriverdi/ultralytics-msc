import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodingForModel } from "js-tiktoken";

import { logger } from "../utils/logger.js";
import type { LlmRuntimeConfig } from "../config/env.js";
import { redactSecrets } from "../safety/redaction.js";
import { MOCK_EXTRACTOR_RESPONSE, MOCK_REASONER_RESPONSE, MOCK_VERIFIER_RESPONSE, MOCK_NOTES_RESPONSE } from "./mock_data.js";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompletionOptions {
  promptId: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  reasoningEffort?: "none" | "low" | "medium" | "high";
  verbosity?: "low" | "medium" | "high";
  messages: ChatMessage[];
  fallbackResponse?: string;
  jsonMode?: boolean;
  jsonSchema?: Record<string, unknown>;
}

export interface LlmInvocationResult {
  content: string;
  raw: unknown;
  mode: "network" | "dry-run" | "cache";
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  requestDigest: string | null;
  responseDigest: string | null;
}

const CACHE_DIR = join(process.cwd(), ".cache", "llm");

// Singleton tokenizer to avoid reloading vocab
let tokenizer: any = null;
function getTokenizer() {
  if (!tokenizer) {
    try {
      tokenizer = encodingForModel("gpt-4o"); // Closest approximation for 5.1
    } catch {
      // Fallback if model not found
      logger.warn("Precise tokenizer failed to load; falling back to heuristic.");
      return null;
    }
  }
  return tokenizer;
}

function getMockContent(promptId: string): string {
    if (promptId.includes("extractor")) {
         return JSON.stringify(MOCK_EXTRACTOR_RESPONSE);
    } else if (promptId.includes("reasoner")) {
         return JSON.stringify(MOCK_REASONER_RESPONSE);
    } else if (promptId.includes("verifier")) {
         return JSON.stringify(MOCK_VERIFIER_RESPONSE);
    } else if (promptId.includes("notes")) {
         return JSON.stringify(MOCK_NOTES_RESPONSE);
    }
    return "{}";
}

export async function invokeChatCompletion(
  runtime: LlmRuntimeConfig,
  options: ChatCompletionOptions
): Promise<LlmInvocationResult> {
  const fallback = options.fallbackResponse ?? "";

  // Mock Provider Logic
  if (runtime.provider === "mock") {
    // Log to stderr to bypass buffering
    console.error(`[MOCK] Invoking prompt: ${options.promptId}`);
    // Simulate network latency (reduced)
    await new Promise(resolve => setTimeout(resolve, 10));

    // Check if we have a special mock response for this promptId?
    // For now, just return the fallback or a generic success.
    // If fallback is empty, return a valid generic JSON if jsonMode is on.
    let content = fallback;
    if (options.jsonMode) {
        content = getMockContent(options.promptId);
    }

    return {
      content: content || "Mock response",
      raw: { mock: true },
      mode: "network",
      promptTokens: estimateTokens(JSON.stringify(options.messages)),
      completionTokens: estimateTokens(content || "Mock response"),
      latencyMs: 10,
      requestDigest: "mock-digest",
      responseDigest: "mock-response-digest"
    };
  }

  if (!runtime.enabled || runtime.dryRun) {
    logger.info("LLM runtime disabled or dry-run; returning fallback", {
      promptId: options.promptId,
      enabled: runtime.enabled,
      dryRun: runtime.dryRun
    });
    return {
      content: fallback,
      raw: runtime.privacyMode ? null : { fallback },
      mode: "dry-run",
      promptTokens: 0,
      completionTokens: estimateTokens(fallback),
      latencyMs: 0,
      requestDigest: null,
      responseDigest: runtime.privacyMode ? null : createHash("sha256").update(fallback).digest("hex")
    };
  }

  if (!runtime.model || !runtime.apiKey) {
    logger.warn("LLM runtime missing configuration; returning fallback", {
      promptId: options.promptId,
      hasModel: Boolean(runtime.model),
      hasKey: Boolean(runtime.apiKey)
    });
    return {
      content: fallback,
      raw: runtime.privacyMode ? null : { fallback },
      mode: "dry-run",
      promptTokens: 0,
      completionTokens: estimateTokens(fallback),
      latencyMs: 0,
      requestDigest: null,
      responseDigest: runtime.privacyMode ? null : createHash("sha256").update(fallback).digest("hex")
    };
  }

  // Redact secrets from messages
  const redactedMessages = options.messages.map((msg) => {
    const { content, redactions } = redactSecrets(msg.content);
    if (redactions > 0) {
      logger.warn("Redacted secrets from prompt", { count: redactions, role: msg.role, promptId: options.promptId });
    }
    return { ...msg, content };
  });

  const provider = runtime.provider?.toLowerCase() ?? "openai";
  const payload = createPayload(provider, runtime.model, { ...options, messages: redactedMessages });
  const requestDigest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");

  // Cache Check
  if (runtime.cacheEnabled && !runtime.privacyMode) {
    try {
      const cachePath = join(CACHE_DIR, `${requestDigest}.json`);
      if (existsSync(cachePath)) {
        const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
        logger.debug("LLM cache hit", { promptId: options.promptId, digest: requestDigest });
        return {
          ...cached,
          mode: "cache",
          latencyMs: 0
        };
      }
    } catch (error) {
      logger.warn("Failed to read LLM cache", { error });
    }
  }

  // Rate Limit Handling (Simple exponential backoff)
  // If reasoning effort is high, we retry fewer times to allow downgrade logic to kick in faster.
  // But we ensure at least 2 attempts (1 retry) to handle transient 429s with the long backoff.
  const MAX_RETRIES = options.reasoningEffort === "high" ? 2 : 5;
  let attempt = 0;
  let response: Response | null = null;

  while (attempt < MAX_RETRIES) {
    const headers = createHeaders(provider, runtime.apiKey);
    const endpoint = resolveEndpoint(provider, runtime.baseUrl, runtime.model, runtime.apiKey);

    const start = performance.now();
    try {
      // 30 minute timeout for high-reasoning models to accommodate deep thought chains
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1800000);

      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
    } catch (error) {
      attempt++;
      const delay = Math.pow(2, attempt) * 2000; // 4s, 8s...
      logger.warn("LLM network request failed; retrying...", {
        attempt,
        provider,
        error: error instanceof Error ? error.message : String(error),
        cause: error instanceof Error ? (error as any).cause : undefined
      });
      if (attempt >= MAX_RETRIES) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    const latencyMs = performance.now() - start;

    if (response.status === 429) {
      attempt++;
      let delay = Math.pow(2, attempt) * 30000; // Start at 60s (2^1 * 30000)

      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) {
          delay = (seconds + 1) * 1000; // Add 1s buffer
        }
      }

      logger.warn(`Rate limit hit. Retrying in ${delay}ms...`, { attempt, provider, retryAfter });
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text();
      let sanitizedEndpoint = endpoint;
      try {
        const urlObj = new URL(endpoint);
        if (urlObj.searchParams.has("key")) urlObj.searchParams.set("key", "<redacted>");
        sanitizedEndpoint = urlObj.toString();
      } catch {}

      logger.error("LLM invocation failed", {
        status: response.status,
        statusText: response.statusText,
        body: runtime.privacyMode ? "<redacted>" : errorText,
        provider,
        endpoint: sanitizedEndpoint
      });
      throw new Error(`LLM request failed with status ${response.status}`);
    }

    // Success
    const data = await response.json();
    const content = extractContent(data, provider);

    // Usage extraction is provider specific, but we'll try standard OpenAI first or estimate
    let promptTokens = 0;
    let completionTokens = 0;

    if (data?.usage) {
      promptTokens = data.usage.prompt_tokens ?? 0;
      completionTokens = data.usage.completion_tokens ?? 0;
    } else if (data?.usageMetadata) {
      // Google
      promptTokens = data.usageMetadata.promptTokenCount ?? 0;
      completionTokens = data.usageMetadata.candidatesTokenCount ?? 0;
    } else if (data?.input_tokens && data?.output_tokens) {
      // Anthropic
      promptTokens = data.input_tokens;
      completionTokens = data.output_tokens;
    } else {
      promptTokens = estimateTokens(JSON.stringify(options.messages));
      completionTokens = estimateTokens(content);
    }

    const responseDigest = runtime.privacyMode
      ? null
      : createHash("sha256").update(JSON.stringify(data)).digest("hex");

    const result: LlmInvocationResult = {
      content,
      raw: runtime.privacyMode ? null : data,
      mode: "network",
      promptTokens,
      completionTokens,
      latencyMs,
      requestDigest,
      responseDigest
    };

    // Cache Write
    if (runtime.cacheEnabled && !runtime.privacyMode) {
      try {
        if (!existsSync(CACHE_DIR)) {
          mkdirSync(CACHE_DIR, { recursive: true });
        }
        writeFileSync(join(CACHE_DIR, `${requestDigest}.json`), JSON.stringify(result, null, 2));
      } catch (error) {
        logger.warn("Failed to write LLM cache", { error });
      }
    }

    return result;
  }

  throw new Error("Max retries exceeded");
}

function createHeaders(provider: string, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (provider === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (provider === "google") {
    // Google often uses query param, but we can try header if supported by specific endpoint
    // For now, we rely on query param injection in resolveEndpoint for Google AI Studio
  } else if (provider.includes("azure")) {
    headers["api-key"] = apiKey;
  } else {
    // OpenAI, xAI, DeepSeek, Moonshot, etc.
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  return headers;
}

function resolveEndpoint(provider: string, baseUrl: string | null, model: string, apiKey: string): string {
  if (baseUrl) {
    return baseUrl.replace(/\/$/, "");
  }

  switch (provider) {
    case "anthropic":
      return "https://api.anthropic.com/v1/messages";
    case "google":
      return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    case "xai":
      return "https://api.x.ai/v1/chat/completions";
    case "deepseek":
      return "https://api.deepseek.com/chat/completions";
    case "moonshot":
      return "https://api.moonshot.cn/v1/chat/completions";
    case "alibaba":
      return "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
    case "azure":
      // Azure requires a specific URL structure usually provided via baseUrl, but if not:
      throw new Error("Azure provider requires a valid baseUrl (e.g. https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version=...)");
    default:
      return "https://api.openai.com/v1/chat/completions";
  }
}

function createPayload(provider: string, model: string, options: ChatCompletionOptions): unknown {
  if (provider === "anthropic") {
    const systemMessage = options.messages.find(m => m.role === "system");
    const messages = options.messages.filter(m => m.role !== "system");
    return {
      model,
      messages,
      system: systemMessage?.content,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      top_p: options.topP,
    };
  }

  if (provider === "google") {
    const systemMessage = options.messages.find(m => m.role === "system");
    const contents = options.messages
      .filter(m => m.role !== "system")
      .map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
      }));

    return {
      contents,
      systemInstruction: systemMessage ? { parts: [{ text: systemMessage.content }] } : undefined,
      generationConfig: {
        temperature: options.temperature,
        topP: options.topP,
        maxOutputTokens: options.maxTokens,
        responseMimeType: options.jsonMode ? "application/json" : "text/plain"
      }
    };
  }

  // OpenAI Compatible
  let responseFormat: unknown = undefined;
  if (options.jsonSchema) {
    responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: true,
        schema: options.jsonSchema
      }
    };
  } else if (options.jsonMode) {
    responseFormat = { type: "json_object" };
  }

  // O1 models (o1-preview, o1-mini) do not support temperature, top_p, or max_tokens (use max_completion_tokens)
  // and they don't support system messages in the 'messages' array in the same way (they use 'developer' role or just user)
  // but for now we'll just strip unsupported params.
  // GPT-5.1 also requires max_completion_tokens instead of max_tokens.
  if (model.startsWith("o1-") || model.startsWith("gpt-5.1")) {
    const payload: any = {
      model,
      messages: options.messages,
      max_completion_tokens: options.maxTokens,
      ...(responseFormat ? { response_format: responseFormat } : {})
    };

    // GPT-5.1 supports reasoning_effort
    if (options.reasoningEffort) {
      payload.reasoning_effort = options.reasoningEffort;
    }

    // GPT-5.1 supports verbosity
    if (options.verbosity) {
      payload.verbosity = options.verbosity;
    }

    // GPT-5.1 ONLY supports temperature/top_p if reasoning_effort is "none"
    if (model.startsWith("gpt-5.1") && options.reasoningEffort === "none") {
      payload.temperature = options.temperature;
      payload.top_p = options.topP;
    }

    return payload;
  }

  return {
    model,
    messages: options.messages,
    temperature: options.temperature,
    top_p: options.topP,
    max_tokens: options.maxTokens,
    ...(responseFormat ? { response_format: responseFormat } : {})
  };
}

function extractContent(result: any, provider: string): string {
  if (!result) {
    return "";
  }

  if (provider === "anthropic") {
    if (Array.isArray(result.content) && result.content.length > 0) {
      return result.content[0].text;
    }
  }

  if (provider === "google") {
    if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
      return result.candidates[0].content.parts[0].text;
    }
  }

  // OpenAI / Azure / Compatible
  if (Array.isArray(result.choices) && result.choices.length > 0) {
    const choice = result.choices[0];
    if (choice.message?.content) {
      return String(choice.message.content);
    }
    if (choice.text) {
      return String(choice.text);
    }
  }
  if (typeof result.content === "string") {
    return result.content;
  }
  return JSON.stringify(result);
}

export function estimateTokens(payload: string): number {
  if (!payload) {
    return 0;
  }
  const enc = getTokenizer();
  if (enc) {
    return enc.encode(payload).length;
  }
  return Math.ceil(payload.length / 4);
}
