import { describe, expect, test } from "bun:test";
import {
  generateEmbedding,
  generateEmbeddings,
  validateConfig,
} from "./generate";
import type { EmbeddingConfig } from "./types";

// =============================================================================
// Integration Tests (conditional)
// =============================================================================

const RUN_INTEGRATION = process.env.RUN_EMBEDDING_INTEGRATION === "1";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

const ollamaConfig: EmbeddingConfig = {
  provider: "ollama",
  model: "nomic-embed-text",
  dimensions: 768,
  baseUrl: OLLAMA_URL,
};

describe.skipIf(!RUN_INTEGRATION)("embedding integration (ollama)", () => {
  test("generateEmbedding returns correct dimensions", async () => {
    const result = await generateEmbedding("test text", ollamaConfig);

    expect(result.embedding).toBeInstanceOf(Array);
    expect(result.embedding.length).toBe(768);
    expect(typeof result.embedding[0]).toBe("number");
    expect(result.tokens).toBeGreaterThan(0);
  });

  test("generateEmbedding handles long text", async () => {
    const longText = "word ".repeat(10000); // Very long text
    const configWithTruncation: EmbeddingConfig = {
      ...ollamaConfig,
      options: { maxTokens: 8000 },
    };

    const result = await generateEmbedding(longText, configWithTruncation);
    expect(result.embedding.length).toBe(768);
    expect(result.tokens).toBeGreaterThan(0);
  });

  test("generateEmbeddings returns results for batch", async () => {
    const rows = [
      { id: "1", content: "first document" },
      { id: "2", content: "second document" },
      { id: "3", content: "third document" },
    ];

    const results = await generateEmbeddings(rows, ollamaConfig);

    expect(results.length).toBe(3);
    for (const result of results) {
      expect(result.embedding.length).toBe(768);
      expect(result.error).toBeUndefined();
    }
  });

  test("generateEmbeddings returns empty array for empty input", async () => {
    const results = await generateEmbeddings([], ollamaConfig);
    expect(results).toEqual([]);
  });

  test("validateConfig succeeds with valid config", async () => {
    await expect(validateConfig(ollamaConfig)).resolves.toBeUndefined();
  });

  test("validateConfig throws on dimension mismatch", async () => {
    const badConfig: EmbeddingConfig = {
      ...ollamaConfig,
      dimensions: 512, // Wrong dimension
    };

    await expect(validateConfig(badConfig)).rejects.toThrow(
      "Dimension mismatch",
    );
  });
});

// =============================================================================
// OpenAI Integration Tests (conditional)
// =============================================================================

const RUN_OPENAI_INTEGRATION = process.env.RUN_OPENAI_INTEGRATION === "1";

const openaiConfig: EmbeddingConfig = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 1536,
};

describe.skipIf(!RUN_OPENAI_INTEGRATION)(
  "embedding integration (openai)",
  () => {
    test("generateEmbedding returns correct dimensions", async () => {
      const result = await generateEmbedding("test text", openaiConfig);

      expect(result.embedding).toBeInstanceOf(Array);
      expect(result.embedding.length).toBe(1536);
      expect(typeof result.embedding[0]).toBe("number");
      expect(result.tokens).toBeGreaterThan(0);
    });

    test("generateEmbedding truncates long text with character estimate", async () => {
      // Create text that would exceed 8191 tokens (~32K chars)
      const longText = "Hello world. ".repeat(4000); // ~52K chars

      const result = await generateEmbedding(longText, openaiConfig);
      expect(result.embedding.length).toBe(1536);
      // Should succeed without error due to truncation
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
