import { describe, expect, test } from "bun:test";
import { extractBearerToken } from "./authenticate";

describe("extractBearerToken", () => {
  test("extracts token from valid Authorization header", () => {
    const request = new Request("http://localhost/test", {
      headers: { Authorization: "Bearer abc123" },
    });
    expect(extractBearerToken(request)).toBe("abc123");
  });

  test("returns null for missing Authorization header", () => {
    const request = new Request("http://localhost/test");
    expect(extractBearerToken(request)).toBeNull();
  });

  test("returns null for non-Bearer Authorization", () => {
    const request = new Request("http://localhost/test", {
      headers: { Authorization: "Basic abc123" },
    });
    expect(extractBearerToken(request)).toBeNull();
  });

  test("returns null for malformed Bearer header", () => {
    const request = new Request("http://localhost/test", {
      headers: { Authorization: "Bearer" },
    });
    expect(extractBearerToken(request)).toBeNull();
  });
});
