/**
 * Unit tests for buildEmbeddingConfig env parsing.
 *
 * No database or network — these just exercise how environment variables map
 * onto the EmbeddingConfig the server boots with. The notable case is
 * EMBEDDING_MAX_RETRIES, which defaults to 0 (the worker's requeue + pool-wide
 * backoff are the single retry authority; the AI SDK's internal retry ladder is
 * disabled unless explicitly re-enabled).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildEmbeddingConfig } from "./start";

const TOUCHED_ENV = [
  "EMBEDDING_API_KEY",
  "EMBEDDING_MAX_RETRIES",
  "EMBEDDING_TIMEOUT_MS",
  "EMBEDDING_MAX_PARALLEL_CALLS",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_MODEL",
] as const;

describe("buildEmbeddingConfig", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of TOUCHED_ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // Required for the function to build at all.
    process.env.EMBEDDING_API_KEY = "test-key";
  });

  afterEach(() => {
    for (const key of TOUCHED_ENV) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  test("defaults maxRetries to 0 when EMBEDDING_MAX_RETRIES is unset", () => {
    const config = buildEmbeddingConfig();
    expect(config.options?.maxRetries).toBe(0);
  });

  test("forwards an explicit EMBEDDING_MAX_RETRIES", () => {
    process.env.EMBEDDING_MAX_RETRIES = "2";
    expect(buildEmbeddingConfig().options?.maxRetries).toBe(2);
  });

  test("forwards an explicit 0 (does not fall back to a default)", () => {
    process.env.EMBEDDING_MAX_RETRIES = "0";
    expect(buildEmbeddingConfig().options?.maxRetries).toBe(0);
  });

  test("throws on a non-integer EMBEDDING_MAX_RETRIES", () => {
    process.env.EMBEDDING_MAX_RETRIES = "nope";
    expect(() => buildEmbeddingConfig()).toThrow("EMBEDDING_MAX_RETRIES");
  });

  test("requires EMBEDDING_API_KEY", () => {
    delete process.env.EMBEDDING_API_KEY;
    expect(() => buildEmbeddingConfig()).toThrow(
      "EMBEDDING_API_KEY is required",
    );
  });

  test("defaults model to text-embedding-3-small", () => {
    expect(buildEmbeddingConfig().model).toBe("text-embedding-3-small");
  });

  test("forwards an explicit EMBEDDING_MODEL (gateway-namespaced name)", () => {
    process.env.EMBEDDING_MODEL = "openai/text-embedding-3-small";
    expect(buildEmbeddingConfig().model).toBe("openai/text-embedding-3-small");
  });

  test("falls back to the default model when EMBEDDING_MODEL is empty", () => {
    process.env.EMBEDDING_MODEL = "";
    expect(buildEmbeddingConfig().model).toBe("text-embedding-3-small");
  });

  test("keeps dimensions at 1536 regardless of the model override", () => {
    process.env.EMBEDDING_MODEL = "openai/text-embedding-3-small";
    expect(buildEmbeddingConfig().dimensions).toBe(1536);
  });

  test("forwards EMBEDDING_BASE_URL for gateway routing", () => {
    process.env.EMBEDDING_BASE_URL = "https://openrouter.ai/api/v1";
    expect(buildEmbeddingConfig().baseUrl).toBe("https://openrouter.ai/api/v1");
  });
});
