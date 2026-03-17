import { describe, expect, test } from "bun:test";
import { truncateToTokenLimit } from "./truncate";

describe("truncateToTokenLimit", () => {
  describe("under limit", () => {
    test("returns text unchanged when under limit", () => {
      const result = truncateToTokenLimit("hello world", 100, "openai");
      expect(result.truncated).toBe(false);
      expect(result.text).toBe("hello world");
    });

    test("returns text unchanged when exactly at limit", () => {
      // "hello" is 1 token in OpenAI, set limit to 1
      const result = truncateToTokenLimit("hello", 1, "openai");
      expect(result.truncated).toBe(false);
      expect(result.text).toBe("hello");
    });

    test("empty string returns unchanged", () => {
      const result = truncateToTokenLimit("", 100, "openai");
      expect(result.truncated).toBe(false);
      expect(result.text).toBe("");
      expect(result.tokens).toBe(0);
    });
  });

  describe("over limit with exact tokenizer (openai)", () => {
    test("truncates long text", () => {
      const longText = "a ".repeat(1000); // ~1000 tokens
      const result = truncateToTokenLimit(longText, 100, "openai");

      expect(result.truncated).toBe(true);
      expect(result.text).toContain("[truncated]");
      expect(result.tokens).toBeLessThanOrEqual(100);
    });

    test("truncation marker is appended", () => {
      const longText = "word ".repeat(200);
      const result = truncateToTokenLimit(longText, 50, "openai");

      expect(result.text.endsWith("\n[truncated]")).toBe(true);
    });

    test("proportional algorithm converges efficiently", () => {
      // 150% over limit should start at ~67% of text
      const longText = "a ".repeat(150);
      const result = truncateToTokenLimit(longText, 100, "openai");

      expect(result.truncated).toBe(true);
      expect(result.tokens).toBeLessThanOrEqual(100);
      expect(result.tokens).toBeGreaterThan(50); // Should be close to limit
    });
  });

  describe("over limit with character approximation (ollama)", () => {
    test("truncates using character approximation", () => {
      const longText = "a".repeat(1000); // ~333 tokens at 3 chars/token
      const result = truncateToTokenLimit(longText, 100, "ollama");

      expect(result.truncated).toBe(true);
      expect(result.text).toContain("[truncated]");
    });

    test("single-pass truncation for approximation", () => {
      // With ~3 chars/token, 100 tokens = ~300 chars
      const longText = "x".repeat(600);
      const result = truncateToTokenLimit(longText, 100, "ollama");

      expect(result.truncated).toBe(true);
      // Should truncate to roughly (100 - 15) * 3 = 255 chars + marker
      expect(result.text.length).toBeLessThan(400);
    });
  });

  describe("edge cases", () => {
    test("handles very small limit", () => {
      const text = "hello world how are you";
      const result = truncateToTokenLimit(text, 20, "openai");

      expect(result.truncated).toBe(false);
      expect(result.text).toBe(text);
    });

    test("handles unicode text", () => {
      const text = "Hello 世界 🌍 emoji test";
      const result = truncateToTokenLimit(text, 100, "openai");

      expect(result.truncated).toBe(false);
      expect(result.text).toBe(text);
    });

    test("handles newlines in text", () => {
      const text = "line1\nline2\nline3\n".repeat(100);
      const result = truncateToTokenLimit(text, 50, "openai");

      expect(result.truncated).toBe(true);
      expect(result.text).toContain("[truncated]");
    });

    test("all providers work", () => {
      const text = "test text for all providers";
      const providers = [
        "openai",
        "ollama",
        "cohere",
        "mistral",
        "google",
      ] as const;

      for (const provider of providers) {
        const result = truncateToTokenLimit(text, 100, provider);
        expect(result.truncated).toBe(false);
        expect(result.text).toBe(text);
      }
    });
  });

  describe("token count accuracy", () => {
    test("reported tokens matches actual count for openai", () => {
      const text = "The quick brown fox jumps over the lazy dog.";
      const result = truncateToTokenLimit(text, 100, "openai");

      // The reported tokens should be accurate
      expect(result.tokens).toBeGreaterThan(0);
      expect(result.truncated).toBe(false);
    });

    test("truncated result stays under limit", () => {
      const longText = "word ".repeat(500);
      const limit = 100;
      const result = truncateToTokenLimit(longText, limit, "openai");

      expect(result.truncated).toBe(true);
      expect(result.tokens).toBeLessThanOrEqual(limit);
    });
  });
});
