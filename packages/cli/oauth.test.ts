import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  buildAuthorizeUrl,
  generatePkce,
  generateState,
  OAUTH_CLIENT_ID,
  OAUTH_SCOPE,
} from "./oauth";

describe("PKCE", () => {
  test("challenge is S256(verifier) in base64url", async () => {
    const { verifier, challenge } = await generatePkce();
    expect(challenge).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
    // base64url: no +, /, or = padding
    expect(verifier).not.toMatch(/[+/=]/);
    expect(challenge).not.toMatch(/[+/=]/);
  });

  test("pairs + state are unique per call", async () => {
    const a = await generatePkce();
    const b = await generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(generateState()).not.toBe(generateState());
  });
});

describe("buildAuthorizeUrl", () => {
  test("builds the public-client auth-code + PKCE authorize URL", () => {
    const url = new URL(
      buildAuthorizeUrl({
        server: "https://api.example.com/",
        redirectUri: "http://127.0.0.1:54321/callback",
        codeChallenge: "abc123",
        state: "xyz",
      }),
    );
    expect(url.pathname).toBe("/api/v1/auth/oauth2/authorize");
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe(OAUTH_CLIENT_ID);
    expect(q.get("redirect_uri")).toBe("http://127.0.0.1:54321/callback");
    expect(q.get("code_challenge")).toBe("abc123");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("state")).toBe("xyz");
    expect(q.get("scope")).toBe(OAUTH_SCOPE);
  });
});
