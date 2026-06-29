import { describe, expect, test } from "bun:test";
import { RateLimitError } from "./errors";
import {
  generateEmbedding,
  generateEmbeddings,
  validateConfig,
} from "./generate";
import type { EmbeddingConfig } from "./types";

// =============================================================================
// OpenAI Integration Tests (conditional)
// =============================================================================

const RUN_OPENAI_INTEGRATION = process.env.RUN_OPENAI_INTEGRATION === "1";

const openaiConfig: EmbeddingConfig = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 1536,
};

// TEST_CI disables conditional skips: in CI this suite always runs (missing
// credentials fail loudly as test errors, never as a silent skip). Locally
// it stays opt-in via RUN_OPENAI_INTEGRATION=1.
describe.skipIf(!process.env.TEST_CI && !RUN_OPENAI_INTEGRATION)(
  "embedding integration (openai)",
  () => {
    test("generateEmbedding returns correct dimensions", async () => {
      const result = await generateEmbedding("test text", openaiConfig);

      expect(result.embedding).toBeInstanceOf(Array);
      expect(result.embedding.length).toBe(1536);
      expect(typeof result.embedding[0]).toBe("number");
      expect(result.tokens).toBeGreaterThan(0);
    });

    test("generateEmbedding truncates long text to the exact token limit", async () => {
      // Create text that would exceed 8191 tokens (~32K chars)
      const longText = "Hello world. ".repeat(4000); // ~52K chars

      const result = await generateEmbedding(longText, openaiConfig);
      expect(result.embedding.length).toBe(1536);
      // Should succeed without error due to exact token-based truncation
    });

    test("generateEmbedding embeds token-dense content that would exceed the limit", async () => {
      // Dense CJK content: ~1 token/char, so this far exceeds 8191 tokens and
      // would have failed the old char-based truncation (which assumed ~2.5+
      // chars/token). Exact token truncation must keep it under the limit.
      const dense = "あ".repeat(20000);

      const result = await generateEmbedding(dense, openaiConfig);
      expect(result.embedding.length).toBe(1536);
    });

    test("generateEmbeddings handles batch with truncation", async () => {
      const rows = [
        { id: "1", content: "short text" },
        { id: "2", content: "Hello world. ".repeat(4000) }, // Long text
        { id: "3", content: "another short one" },
      ];

      const results = await generateEmbeddings(rows, openaiConfig);

      expect(results.length).toBe(3);
      for (const result of results) {
        expect(result.embedding.length).toBe(1536);
        expect(result.error).toBeUndefined();
      }
    });
  },
);

// =============================================================================
// Unit Tests (always run)
// =============================================================================

describe("validateConfig", () => {
  test("throws on missing provider", async () => {
    const config = {
      provider: "",
      model: "test",
      dimensions: 768,
    } as unknown as EmbeddingConfig;

    await expect(validateConfig(config)).rejects.toThrow(
      "provider is required",
    );
  });

  test("throws on missing model", async () => {
    const config: EmbeddingConfig = {
      provider: "openai",
      model: "",
      dimensions: 768,
    };

    await expect(validateConfig(config)).rejects.toThrow("model is required");
  });

  test("throws on invalid dimensions", async () => {
    const config: EmbeddingConfig = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 0,
    };

    await expect(validateConfig(config)).rejects.toThrow(
      "dimensions must be a positive number",
    );
  });

  test("throws on negative dimensions", async () => {
    const config: EmbeddingConfig = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: -1,
    };

    await expect(validateConfig(config)).rejects.toThrow(
      "dimensions must be a positive number",
    );
  });
});

describe("generateEmbeddings edge cases", () => {
  test("handles empty rows array", async () => {
    // This should not make any API calls
    const config: EmbeddingConfig = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    };

    const results = await generateEmbeddings([], config);
    expect(results).toEqual([]);
  });
});

// =============================================================================
// Rate Limit Tests (mock server)
// =============================================================================

describe("rate limit handling", () => {
  test("generateEmbeddings throws RateLimitError on 429 (no individual fallback)", async () => {
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requestCount++;
        return new Response(
          JSON.stringify({
            error: { message: "Rate limited", type: "rate_limit_error" },
          }),
          {
            status: 429,
            headers: { "retry-after-ms": "5000" },
          },
        );
      },
    });

    try {
      const config: EmbeddingConfig = {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        apiKey: "test-key",
        baseUrl: `http://localhost:${server.port}/v1`,
        options: { maxRetries: 0 },
      };

      const rows = [
        { id: "1", content: "first" },
        { id: "2", content: "second" },
        { id: "3", content: "third" },
      ];

      await expect(generateEmbeddings(rows, config)).rejects.toBeInstanceOf(
        RateLimitError,
      );

      // With maxRetries: 0, should be exactly 1 batch request.
      // Critically, should NOT fall back to 3 individual requests.
      expect(requestCount).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("generateEmbeddings RateLimitError carries retryAfterMs from header", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({
            error: { message: "Rate limited", type: "rate_limit_error" },
          }),
          {
            status: 429,
            headers: { "retry-after-ms": "7500" },
          },
        );
      },
    });

    try {
      const config: EmbeddingConfig = {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        apiKey: "test-key",
        baseUrl: `http://localhost:${server.port}/v1`,
        options: { maxRetries: 0 },
      };

      try {
        await generateEmbeddings([{ id: "1", content: "test" }], config);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        const rle = err as RateLimitError;
        expect(rle.retryAfterMs).toBe(7500);
      }
    } finally {
      server.stop();
    }
  });

  test("generateEmbedding throws RateLimitError on 429", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({
            error: { message: "Rate limited", type: "rate_limit_error" },
          }),
          { status: 429 },
        );
      },
    });

    try {
      const config: EmbeddingConfig = {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        apiKey: "test-key",
        baseUrl: `http://localhost:${server.port}/v1`,
        options: { maxRetries: 0 },
      };

      await expect(
        generateEmbedding("test text", config),
      ).rejects.toBeInstanceOf(RateLimitError);
    } finally {
      server.stop();
    }
  });

  test("non-429 errors still fall back to individual requests", async () => {
    let requestCount = 0;
    const mockEmbedding = Array.from({ length: 1536 }, (_, i) => i * 0.001);
    const server = Bun.serve({
      port: 0,
      fetch() {
        requestCount++;
        // First request (batch) fails with 500, individual requests succeed
        if (requestCount === 1) {
          return new Response(
            JSON.stringify({
              error: {
                message: "Internal Server Error",
                type: "server_error",
              },
            }),
            { status: 500 },
          );
        }
        return Response.json({
          object: "list",
          data: [{ object: "embedding", embedding: mockEmbedding, index: 0 }],
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 5, total_tokens: 5 },
        });
      },
    });

    try {
      const config: EmbeddingConfig = {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        apiKey: "test-key",
        baseUrl: `http://localhost:${server.port}/v1`,
        options: { maxRetries: 0 },
      };

      const rows = [
        { id: "1", content: "first" },
        { id: "2", content: "second" },
      ];

      const results = await generateEmbeddings(rows, config);

      // Should have fallen back to individual requests
      expect(results.length).toBe(2);
      // 1 batch + 2 individual = 3 requests
      expect(requestCount).toBe(3);
      for (const result of results) {
        expect(result.error).toBeUndefined();
        expect(result.embedding.length).toBe(1536);
      }
    } finally {
      server.stop();
    }
  });

  test("batch context-length error falls back to individual requests", async () => {
    const requests: string[] = [];
    const mockEmbedding = Array.from({ length: 1536 }, (_, i) => i * 0.001);
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { input: string | string[] };
        const input = Array.isArray(body.input) ? body.input[0] : body.input;
        requests.push(input ?? "");

        // First request is the batch — fail it with a context-length error so
        // the OpenAI individual-fallback path engages. Individual requests
        // (already token-truncated) succeed.
        if (requests.length === 1) {
          return new Response(
            JSON.stringify({
              error: {
                message:
                  "Invalid 'input[0]': maximum input length is 8192 tokens.",
                type: "invalid_request_error",
              },
            }),
            { status: 400 },
          );
        }

        return Response.json({
          object: "list",
          data: [{ object: "embedding", embedding: mockEmbedding, index: 0 }],
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 5, total_tokens: 5 },
        });
      },
    });

    try {
      const config: EmbeddingConfig = {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        apiKey: "test-key",
        baseUrl: `http://localhost:${server.port}/v1`,
        options: { maxRetries: 0, maxTokens: 100 },
      };

      const results = await generateEmbeddings(
        [{ id: "1", content: "x".repeat(350) }],
        config,
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.error).toBeUndefined();
      expect(results[0]?.embedding).toHaveLength(1536);

      // 1 batch request + 1 individual fallback request (no char-ratio retries).
      expect(requests).toHaveLength(2);
      // The fallback input was token-truncated below the original length.
      expect(requests[1]?.length ?? 0).toBeLessThanOrEqual(350);
    } finally {
      server.stop();
    }
  });

  test("generateEmbedding retries once on a context-length error", async () => {
    const requests: string[] = [];
    const mockEmbedding = Array.from({ length: 1536 }, (_, i) => i * 0.001);
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { input: string | string[] };
        const input = Array.isArray(body.input) ? body.input[0] : body.input;
        requests.push(input ?? "");

        // First attempt: pretend the API counted more tokens than we targeted.
        // The defensive retry re-truncates and succeeds.
        if (requests.length === 1) {
          return new Response(
            JSON.stringify({
              error: {
                message:
                  "Invalid 'input': maximum input length is 8192 tokens.",
                type: "invalid_request_error",
              },
            }),
            { status: 400 },
          );
        }

        return Response.json({
          object: "list",
          data: [{ object: "embedding", embedding: mockEmbedding, index: 0 }],
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 5, total_tokens: 5 },
        });
      },
    });

    try {
      const config: EmbeddingConfig = {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        apiKey: "test-key",
        baseUrl: `http://localhost:${server.port}/v1`,
        options: { maxRetries: 0, maxTokens: 300 },
      };

      const result = await generateEmbedding("x".repeat(1000), config);

      expect(result.embedding).toHaveLength(1536);
      // One failed attempt + one successful defensive retry.
      expect(requests).toHaveLength(2);
    } finally {
      server.stop();
    }
  });
});
