import { describe, expect, test } from "bun:test";
import { generateToken, tokenHash } from "./hash";

describe("generateToken", () => {
  test("produces a base64url string of the expected length", () => {
    const token = generateToken();
    // 32 bytes base64url-encoded with padding stripped: ceil(32 / 3) * 4 = 44,
    // minus the trailing '=' padding character → 43 chars.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("produces unique values across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(generateToken());
    }
    expect(seen.size).toBe(100);
  });
});

describe("tokenHash", () => {
  test("returns 32 raw bytes", () => {
    const hash = tokenHash("anything");
    expect(hash).toBeInstanceOf(Buffer);
    expect(hash.length).toBe(32);
  });

  test("is deterministic", () => {
    const a = tokenHash("hello world");
    const b = tokenHash("hello world");
    expect(a.equals(b)).toBe(true);
  });

  test("differs for different inputs", () => {
    const a = tokenHash("hello world");
    const b = tokenHash("hello world!");
    expect(a.equals(b)).toBe(false);
  });

  test("matches the published sha256 of a known string", () => {
    // Known value: sha256("abc") = ba7816bf8f01cfea414140de5dae2223
    //                              b00361a396177a9cb410ff61f20015ad
    const hex = tokenHash("abc").toString("hex");
    expect(hex).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
