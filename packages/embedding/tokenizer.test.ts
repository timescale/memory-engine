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

  test("returns null for ollama (no client-side tokenizer)", () => {
    const counter = getTokenCounter("ollama");
    expect(counter).toBeNull();
  });

  test("returns null for cohere (no client-side tokenizer)", () => {
    const counter = getTokenCounter("cohere");
    expect(counter).toBeNull();
  });

  test("returns null for google (no client-side tokenizer)", () => {
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

  test("empty string returns 0 tokens", () => {
    const counter = getTokenCounter("openai")!;
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
