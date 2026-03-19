import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CHARS_PER_TOKEN,
  MAX_OPENAI_TOKENS,
  TRUNCATION_RATIOS,
  truncateText,
} from "./truncate";

describe("truncateText", () => {
  describe("under limit", () => {
    test("returns text unchanged when under limit", () => {
      const result = truncateText("hello world", 100);
      expect(result.truncated).toBe(false);
      expect(result.text).toBe("hello world");
    });

    test("returns text unchanged when exactly at char limit", () => {
      const maxChars = Math.floor(100 * DEFAULT_CHARS_PER_TOKEN);
      const text = "a".repeat(maxChars);
      const result = truncateText(text, 100);
      expect(result.truncated).toBe(false);
      expect(result.text).toBe(text);
    });

    test("empty string returns unchanged", () => {
      const result = truncateText("", 100);
      expect(result.truncated).toBe(false);
      expect(result.text).toBe("");
    });
  });

  describe("over limit", () => {
    test("truncates long text", () => {
      const longText = "a".repeat(100000); // Way over limit
      const result = truncateText(longText, 100);

      expect(result.truncated).toBe(true);
      expect(result.text.length).toBe(
        Math.floor(100 * DEFAULT_CHARS_PER_TOKEN),
      );
    });

    test("uses default maxTokens when not specified", () => {
      const maxChars = Math.floor(MAX_OPENAI_TOKENS * DEFAULT_CHARS_PER_TOKEN);
      const longText = "a".repeat(maxChars + 1000);
      const result = truncateText(longText);

      expect(result.truncated).toBe(true);
      expect(result.text.length).toBe(maxChars);
    });

    test("respects custom charsPerToken ratio", () => {
      const text = "a".repeat(1000);
      const result = truncateText(text, 100, 2.0); // 2 chars per token = 200 chars max

      expect(result.truncated).toBe(true);
      expect(result.text.length).toBe(200);
    });
  });

  describe("edge cases", () => {
    test("handles unicode text", () => {
      const text = "Hello 世界 🌍 emoji test";
      const result = truncateText(text, 100);

      expect(result.truncated).toBe(false);
      expect(result.text).toBe(text);
    });

    test("handles newlines in text", () => {
      const text = "line1\nline2\nline3\n".repeat(10000);
      const result = truncateText(text, 100);

      expect(result.truncated).toBe(true);
      expect(result.text.length).toBe(
        Math.floor(100 * DEFAULT_CHARS_PER_TOKEN),
      );
    });

    test("slices at exact character boundary", () => {
      const text = "abcdefghij"; // 10 chars
      const result = truncateText(text, 1, 5); // 5 chars max

      expect(result.truncated).toBe(true);
      expect(result.text).toBe("abcde");
    });
  });

  describe("constants", () => {
    test("DEFAULT_CHARS_PER_TOKEN is 3.8", () => {
      expect(DEFAULT_CHARS_PER_TOKEN).toBe(3.8);
    });

    test("MAX_OPENAI_TOKENS is 8191", () => {
      expect(MAX_OPENAI_TOKENS).toBe(8191);
    });

    test("TRUNCATION_RATIOS for retry logic", () => {
      expect(TRUNCATION_RATIOS).toEqual([3.8, 3.0, 2.5]);
    });
  });

  describe("performance", () => {
    test("is O(1) - handles large text instantly", () => {
      const hugeText = "a".repeat(10_000_000); // 10MB of text

      const start = performance.now();
      const result = truncateText(hugeText, 8191);
      const elapsed = performance.now() - start;

      expect(result.truncated).toBe(true);
      expect(elapsed).toBeLessThan(10); // Should be < 10ms
    });
  });
});
