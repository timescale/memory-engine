/**
 * Tests for the `/login` page's social sign-in callbackURL builder.
 *
 * Pure function — no React, only URLSearchParams (present in Bun and browsers).
 */
import { describe, expect, test } from "bun:test";
import { buildAuthorizeCallbackURL } from "./oauth-callback.ts";

const AUTHORIZE_PATH = "/api/v1/auth/oauth2/authorize";

describe("buildAuthorizeCallbackURL", () => {
  test("normal login returns the signed query verbatim", () => {
    const search =
      "?response_type=code&client_id=me-cli&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback&scope=offline_access&state=xyz&code_challenge=abc&code_challenge_method=S256&exp=123&sig=deadbeef";
    expect(buildAuthorizeCallbackURL(search)).toBe(
      `${AUTHORIZE_PATH}${search}`,
    );
  });

  test("empty query returns the bare authorize path", () => {
    expect(buildAuthorizeCallbackURL("")).toBe(AUTHORIZE_PATH);
  });

  test("switch login (prompt=login) drops prompt and the signing params", () => {
    const search =
      "?response_type=code&client_id=me-cli&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback&scope=offline_access&state=xyz&code_challenge=abc&code_challenge_method=S256&prompt=login&exp=123&sig=deadbeef";
    const result = buildAuthorizeCallbackURL(search);
    const url = new URL(result, "https://api.example.com");

    expect(url.pathname).toBe(AUTHORIZE_PATH);
    // prompt is what caused the redirect loop — it must not survive.
    expect(url.searchParams.has("prompt")).toBe(false);
    // better-auth signing params are dropped too (removing prompt voids the sig).
    expect(url.searchParams.has("sig")).toBe(false);
    expect(url.searchParams.has("exp")).toBe(false);
    // the original OAuth request is preserved intact.
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("me-cli");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:54321/callback",
    );
    expect(url.searchParams.get("scope")).toBe("offline_access");
    expect(url.searchParams.get("state")).toBe("xyz");
    expect(url.searchParams.get("code_challenge")).toBe("abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("switch login omits absent optional params rather than emitting blanks", () => {
    // No scope/state in the incoming query → they should simply be absent.
    const search =
      "?response_type=code&client_id=me-cli&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback&code_challenge=abc&code_challenge_method=S256&prompt=login&sig=x";
    const url = new URL(
      buildAuthorizeCallbackURL(search),
      "https://api.example.com",
    );
    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.searchParams.has("state")).toBe(false);
    expect(url.searchParams.get("client_id")).toBe("me-cli");
  });

  test("a non-login prompt (e.g. consent) is preserved verbatim", () => {
    // Only `login` loops through this page; other prompts keep their signed
    // query so better-auth resolves them (e.g. via its consent page).
    const search =
      "?response_type=code&client_id=me-cli&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback&prompt=consent&sig=deadbeef";
    expect(buildAuthorizeCallbackURL(search)).toBe(
      `${AUTHORIZE_PATH}${search}`,
    );
  });

  test("a space-delimited prompt set containing login triggers the rebuild", () => {
    const search =
      "?response_type=code&client_id=me-cli&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback&prompt=login+consent&sig=x";
    const url = new URL(
      buildAuthorizeCallbackURL(search),
      "https://api.example.com",
    );
    expect(url.searchParams.has("prompt")).toBe(false);
    expect(url.searchParams.has("sig")).toBe(false);
    expect(url.searchParams.get("client_id")).toBe("me-cli");
  });

  test("prompt=login with no OAuth params yields the bare path (no trailing '?')", () => {
    expect(buildAuthorizeCallbackURL("?prompt=login&sig=x")).toBe(
      AUTHORIZE_PATH,
    );
  });
});
