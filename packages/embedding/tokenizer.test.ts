import { describe, expect, test } from "bun:test";
import { _resetTokenizer, countTokens, getTokenCounter } from "./tokenizer";

describe("getTokenCounter", () => {
  test("returns exact tokenizer for openai", () => {
    const counter = getTokenCounter("openai");
    expect(counter).not.toBeNull();
    expect(counter!.count("hello world")).toBeGreaterThan(0);
  });

  test("returns exact tokenizer for mistral", () => {
    const counter = getTokenCounter("mistral");
    expect(counter).not.toBeNull();
    expect(counter!.count("hello world")).toBeGreaterThan(0);
  });

  test("returns null for ollama (character approximation)", () => {
    const counter = getTokenCounter("ollama");
    expect(counter).toBeNull();
  });

  test("returns null for cohere (character approximation)", () => {
    const counter = getTokenCounter("cohere");
    expect(counter).toBeNull();
  });

  test("returns null for google (character approximation)", () => {
    const counter = getTokenCounter("google");
    expect(counter).toBeNull();
  });

  test("openai tokenizer is singleton (same instance)", () => {
    _resetTokenizer();
    const counter1 = getTokenCounter("openai");
    const counter2 = getTokenCounter("openai");
    // Both should work identically
    expect(counter1!.count("test")).toBe(counter2!.count("test"));
  });
});

describe("countTokens", () => {
  test("uses exact counter when provided", () => {
    const mockCounter = { count: (text: string) => text.length * 2 };
    expect(countTokens("hello", mockCounter)).toBe(10);
  });

  test("uses character approximation when counter is null", () => {
    // Approximation: Math.ceil((length / 4) * 1.3) = ~3 chars/token effective
    const text = "hello world"; // 11 chars
    const tokens = countTokens(text, null);
    // 11 / 4 * 1.3 = 3.575 -> ceil -> 4
    expect(tokens).toBe(4);
  });

  test("character approximation is conservative for code", () => {
    // Code with special chars should use more tokens
    const code = "const x = (a, b) => { return a + b; }"; // 38 chars
    const tokens = countTokens(code, null);
    // 38 / 4 * 1.3 = 12.35 -> ceil -> 13
    expect(tokens).toBe(13);
  });

  test("empty string returns 0 tokens", () => {
    expect(countTokens("", null)).toBe(0);
    const counter = getTokenCounter("openai");
    expect(countTokens("", counter)).toBe(0);
  });
});

describe("openai tokenizer accuracy", () => {
  test("counts tokens correctly for simple text", () => {
    const counter = getTokenCounter("openai");
    // "hello world" is typically 2 tokens in cl100k_base
    expect(counter!.count("hello world")).toBe(2);
  });

  test("counts tokens correctly for longer text", () => {
    const counter = getTokenCounter("openai");
    const text = "The quick brown fox jumps over the lazy dog.";
    // This is typically 10 tokens
    const tokens = counter!.count(text);
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(20);
  });
});

describe("mistral tokenizer accuracy", () => {
  test("counts tokens correctly for simple text", () => {
    const counter = getTokenCounter("mistral");
    const tokens = counter!.count("hello world");
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });
});
