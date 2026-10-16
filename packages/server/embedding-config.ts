import type { EmbeddingConfig } from "@memory.build/embedding";
import { embeddingConstants } from "./config";

/**
 * Parse an integer from an environment variable with NaN guard.
 */
export function parseIntEnv(
  name: string,
  value: string,
  defaultValue: string,
): number {
  const raw = value || defaultValue;
  const parsed = Number(raw);
  if (!raw.trim() || !Number.isSafeInteger(parsed)) {
    throw new Error(
      `Invalid value for ${name}: "${raw}" is not a valid integer`,
    );
  }
  return parsed;
}

/**
 * Build the embedding config from environment variables. Requires
 * EMBEDDING_API_KEY (the server won't boot without it). Used as the default
 * when `StartServerOptions.embeddingConfig` is not supplied.
 *
 * The provider is always the OpenAI SDK client, which speaks the
 * OpenAI-compatible /embeddings protocol — so pointing EMBEDDING_BASE_URL at a
 * gateway (e.g. OpenRouter's https://openrouter.ai/api/v1) plus that gateway's
 * key in EMBEDDING_API_KEY is all that's needed to route through it.
 * EMBEDDING_MODEL exists because gateways rename models (OpenRouter wants
 * "openai/text-embedding-3-small"). Dimensions stay fixed at 1536 to match the
 * halfvec(1536) column — see embeddingConstants.
 */
export function buildEmbeddingConfig(): EmbeddingConfig {
  const apiKey = process.env.EMBEDDING_API_KEY;
  if (!apiKey) {
    throw new Error("EMBEDDING_API_KEY is required");
  }

  const options: EmbeddingConfig["options"] = {};

  if (process.env.EMBEDDING_TIMEOUT_MS) {
    options.timeoutMs = parseIntEnv(
      "EMBEDDING_TIMEOUT_MS",
      process.env.EMBEDDING_TIMEOUT_MS,
      "0",
    );
  }
  // Default to 0: the worker's own visibility-timeout requeue + the pool-wide
  // rate-limit backoff are the single retry authority, so the AI SDK's internal
  // retry ladder (default 2 → 3 attempts) is redundant and actively harmful
  // during a provider 429 — it multiplies the calls behind every surfaced
  // error. Set EMBEDDING_MAX_RETRIES explicitly to re-enable SDK retries.
  options.maxRetries = parseIntEnv(
    "EMBEDDING_MAX_RETRIES",
    process.env.EMBEDDING_MAX_RETRIES || "",
    "0",
  );
  if (process.env.EMBEDDING_MAX_PARALLEL_CALLS) {
    options.maxParallelCalls = parseIntEnv(
      "EMBEDDING_MAX_PARALLEL_CALLS",
      process.env.EMBEDDING_MAX_PARALLEL_CALLS,
      "0",
    );
  }

  return {
    provider: "openai",
    model: process.env.EMBEDDING_MODEL || embeddingConstants.model,
    dimensions: embeddingConstants.dimensions,
    apiKey,
    baseUrl: process.env.EMBEDDING_BASE_URL,
    options,
  };
}
