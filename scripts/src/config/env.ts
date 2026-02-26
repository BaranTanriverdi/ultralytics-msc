import { DEFAULT_LLM_SETTINGS, DEFAULT_RATE_LIMITS, LLM_ENV_VARIABLES } from "../constants.js";

export interface LlmRuntimeConfig {
  enabled: boolean;
  dryRun: boolean;
  privacyMode: boolean;
  cacheEnabled: boolean;
  apiKey: string | null;
  baseUrl: string | null;
  provider: string | null;
  model: string | null;
  sampling: typeof DEFAULT_LLM_SETTINGS;
  rateLimits: typeof DEFAULT_RATE_LIMITS;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value === "1" || value.toLowerCase() === "true";
}

export function resolveLlmRuntimeConfig(env: NodeJS.ProcessEnv = process.env): LlmRuntimeConfig {
  const enabled = parseBoolean(env[LLM_ENV_VARIABLES.enabled], false);
  const dryRun = parseBoolean(env[LLM_ENV_VARIABLES.dryRun], true);
  const privacyMode = parseBoolean(env[LLM_ENV_VARIABLES.privacyMode], false);
  const cacheEnabled = parseBoolean(env["LLM_CACHE_ENABLED"], true);

  return {
    enabled,
    dryRun,
    privacyMode,
    cacheEnabled,
    apiKey: env[LLM_ENV_VARIABLES.apiKey] ?? null,
    baseUrl: env[LLM_ENV_VARIABLES.baseUrl] ?? null,
    provider: env[LLM_ENV_VARIABLES.provider] ?? null,
    model: env[LLM_ENV_VARIABLES.model] ?? null,
    sampling: DEFAULT_LLM_SETTINGS,
    rateLimits: DEFAULT_RATE_LIMITS
  };
}
