import { describe, expect, test } from "bun:test";
import { encode, isWithinTokenLimit } from "gpt-tokenizer/encoding/cl100k_base";
import {
  clipToCharLimit,
  DEFAULT_CHARS_PER_TOKEN,
  MAX_OPENAI_TOKENS,
  safeCharFloor,
  truncateText,
  truncateToTokenLimit,
} from "./truncate";

describe("clipToCharLimit", () => {
  test("returns text unchanged when under the character limit", () => {
    expect(clipToCharLimit("hello", 10)).toBe("hello");
  });

  test("clips plain text to the character limit", () => {
    expect(clipToCharLimit("abcdef", 3)).toBe("abc");
  });

  test("does not leave a dangling high surrogate at the boundary", () => {
    const result = clipToCharLimit("a😀b", 2);

    expect(result).toBe("a");
    expect(result.length).toBe(1);
  });

  test("keeps a complete surrogate pair when the boundary is clean", () => {
    const result = clipToCharLimit("a😀b", 3);

    expect(result).toBe("a😀");
    expect(result.length).toBe(3);
  });

  test("rejects invalid maxChars", () => {
    expect(() => clipToCharLimit("hello", 0)).toThrow(
      "maxChars must be a positive integer",
    );
    expect(() => clipToCharLimit("hello", 1.5)).toThrow(
      "maxChars must be a positive integer",
    );
  });
});

describe("truncateText (char-based)", () => {
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

  describe("validation", () => {
    test("rejects invalid maxTokens", () => {
      expect(() => truncateText("hello", 0)).toThrow(
        "maxTokens must be a positive integer",
      );
      expect(() => truncateText("hello", 1.5)).toThrow(
        "maxTokens must be a positive integer",
      );
    });
  });
});

describe("truncateToTokenLimit (exact token-based)", () => {
  describe("under limit", () => {
    test("returns text unchanged when under the token limit", () => {
      const result = truncateToTokenLimit("hello world", 100);
      expect(result.truncated).toBe(false);
      expect(result.text).toBe("hello world");
    });

    test("empty string returns unchanged", () => {
      const result = truncateToTokenLimit("", 100);
      expect(result.truncated).toBe(false);
      expect(result.text).toBe("");
    });

    test("short text below the safe char floor is never truncated", () => {
      const text = "a".repeat(safeCharFloor(100));
      const result = truncateToTokenLimit(text, 100);
      expect(result.truncated).toBe(false);
      expect(result.text).toBe(text);
    });
  });

  describe("validation", () => {
    test("rejects invalid maxTokens", () => {
      expect(() => truncateToTokenLimit("hello", 0)).toThrow(
        "maxTokens must be a positive integer",
      );
      expect(() => truncateToTokenLimit("hello", Number.NaN)).toThrow(
        "maxTokens must be a positive integer",
      );
    });
  });

  describe("over limit — stays within the exact token bound", () => {
    test("ASCII text is truncated to the token limit", () => {
      const text = "Hello world. ".repeat(4000); // ~52K chars, >8191 tokens
      const result = truncateToTokenLimit(text, MAX_OPENAI_TOKENS);

      expect(result.truncated).toBe(true);
      expect(isWithinTokenLimit(result.text, MAX_OPENAI_TOKENS)).not.toBe(
        false,
      );
    });

    test("token-dense CJK content stays within the limit", () => {
      // ~1 token/char — char-based estimation (2.5+ chars/token) would have
      // left this far over the limit. This is the regression case.
      const dense = "あ".repeat(20000);
      const result = truncateToTokenLimit(dense, MAX_OPENAI_TOKENS);

      expect(result.truncated).toBe(true);
      expect(isWithinTokenLimit(result.text, MAX_OPENAI_TOKENS)).not.toBe(
        false,
      );
    });

    test("dense JSON-like content stays within the limit", () => {
      const json = '{"k":"v","n":12345,"arr":[1,2,3]}'.repeat(2000);
      const result = truncateToTokenLimit(json, 1000);

      expect(result.truncated).toBe(true);
      expect(isWithinTokenLimit(result.text, 1000)).not.toBe(false);
    });

    test("emoji (surrogate pairs) at window boundaries stay within the limit and decode cleanly", () => {
      // Emoji are surrogate pairs; truncating across a window boundary must not
      // corrupt the stream or exceed the limit.
      const emoji = "😀".repeat(20000);
      const result = truncateToTokenLimit(emoji, 500);

      expect(result.truncated).toBe(true);
      expect(isWithinTokenLimit(result.text, 500)).not.toBe(false);
      // No lone replacement chars introduced at window seams (the trailing
      // truncation point may drop a partial char, but interior seams must not).
      expect(result.text.startsWith("😀😀")).toBe(true);
    });

    test("a text just over the safe floor but under the token limit is untouched", () => {
      // Plain ASCII just above the floor: ~0.25 tokens/char, so well under the
      // token limit even though it exceeds the char floor (forces the encode
      // path but yields no truncation).
      const text = "word ".repeat(safeCharFloor(100)); // > floor chars
      const result = truncateToTokenLimit(text, 8191);
      expect(result.truncated).toBe(false);
      expect(result.text).toBe(text);
    });

    test("an input that exactly fits the token limit is not marked truncated", () => {
      const text = "word ".repeat(safeCharFloor(100)); // Forces the encode path.
      const tokenCount = encode(text).length;
      const result = truncateToTokenLimit(text, tokenCount);

      expect(result.truncated).toBe(false);
      expect(result.text).toBe(text);
    });

    test("an exact-fit prefix with remaining input is marked truncated", () => {
      const prefix = "a".repeat(1000); // Exactly one encoder window.
      const tokenCount = encode(prefix).length;
      const result = truncateToTokenLimit(`${prefix} trailing`, tokenCount);

      expect(result.truncated).toBe(true);
      expect(result.text).toBe(prefix);
    });
  });
});

describe("safeCharFloor", () => {
  test("is maxTokens / 3 (floored)", () => {
    expect(safeCharFloor(8191)).toBe(2730);
    expect(safeCharFloor(99)).toBe(33);
  });

  test("guarantees text at the floor is within the token limit", () => {
    // Worst plausible density is ~3 tokens per UTF-16 unit; verify the floor
    // holds for a dense BMP script at the boundary.
    const maxTokens = 300;
    const text = "あ".repeat(safeCharFloor(maxTokens));
    expect(isWithinTokenLimit(text, maxTokens)).not.toBe(false);
  });

  test("rejects invalid maxTokens", () => {
    expect(() => safeCharFloor(0)).toThrow(
      "maxTokens must be a positive integer",
    );
  });
});

describe("constants", () => {
  test("DEFAULT_CHARS_PER_TOKEN is 3.8", () => {
    expect(DEFAULT_CHARS_PER_TOKEN).toBe(3.8);
  });

  test("MAX_OPENAI_TOKENS is 8191", () => {
    expect(MAX_OPENAI_TOKENS).toBe(8191);
  });
});

describe("performance", () => {
  test("truncateToTokenLimit is bounded for huge whitespace-free inputs", () => {
    // Dense, whitespace-free input is the worst case (no segmentation): the
    // windowed encoder must still early-stop quickly rather than BPE-encode the
    // whole thing.
    const hugeText = "あ".repeat(2_000_000);

    const start = performance.now();
    const result = truncateToTokenLimit(hugeText, 8191);
    const elapsed = performance.now() - start;

    expect(result.truncated).toBe(true);
    expect(isWithinTokenLimit(result.text, 8191)).not.toBe(false);
    // Windowed early-stop processes ~maxTokens worth, not the 2M-char input.
    // Keep this loose to avoid machine-load flakes while still catching a
    // regression to full-input encoding.
    expect(elapsed).toBeLessThan(2000);
  });
});
