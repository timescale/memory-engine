import { describe, expect, test } from "bun:test";
import {
  extractBearerToken,
  extractSessionCredential,
  passesCsrfCheck,
} from "./authenticate";

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

  test("ignores cookies (header-only)", () => {
    const request = new Request("http://localhost/test", {
      headers: { Cookie: "me_session=cookietoken" },
    });
    expect(extractBearerToken(request)).toBeNull();
  });
});

describe("extractSessionCredential", () => {
  test("prefers the Authorization header (source=header)", () => {
    const request = new Request("http://localhost/test", {
      headers: {
        Authorization: "Bearer headertoken",
        Cookie: "me_session=cookietoken",
      },
    });
    expect(extractSessionCredential(request, false)).toEqual({
      token: "headertoken",
      source: "header",
    });
  });

  test("falls back to the unprefixed cookie in non-secure mode (source=cookie)", () => {
    const request = new Request("http://localhost/test", {
      headers: { Cookie: "me_session=cookietoken" },
    });
    expect(extractSessionCredential(request, false)).toEqual({
      token: "cookietoken",
      source: "cookie",
    });
  });

  test("reads the __Host- prefixed cookie in secure mode", () => {
    const request = new Request("http://localhost/test", {
      headers: { Cookie: "__Host-me_session=secure-token; other=x" },
    });
    expect(extractSessionCredential(request, true)).toEqual({
      token: "secure-token",
      source: "cookie",
    });
  });

  test("secure mode ignores a plain me_session cookie (__Host- only)", () => {
    const request = new Request("http://localhost/test", {
      headers: { Cookie: "me_session=cookietoken" },
    });
    expect(extractSessionCredential(request, true)).toBeNull();
  });

  test("returns null with no credential", () => {
    const request = new Request("http://localhost/test");
    expect(extractSessionCredential(request, true)).toBeNull();
  });
});

describe("passesCsrfCheck", () => {
  const allowed = ["https://app.example.com"];

  test("allows an allowed Origin", () => {
    const request = new Request("http://localhost/test", {
      headers: { Origin: "https://app.example.com" },
    });
    expect(passesCsrfCheck(request, allowed)).toBe(true);
  });

  test("rejects a foreign Origin", () => {
    const request = new Request("http://localhost/test", {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(passesCsrfCheck(request, allowed)).toBe(false);
  });

  test("rejects a missing Origin without same-site signal", () => {
    const request = new Request("http://localhost/test");
    expect(passesCsrfCheck(request, allowed)).toBe(false);
  });

  test("allows a missing Origin when Sec-Fetch-Site is same-origin", () => {
    const request = new Request("http://localhost/test", {
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(passesCsrfCheck(request, allowed)).toBe(true);
  });
});
