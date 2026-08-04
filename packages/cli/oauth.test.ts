import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import * as realClient from "openid-client";
import { CLIENT_VERSION } from "../../version";

// Mock openid-client BEFORE importing ./oauth so the refresh-grant call is
// intercepted. We spread the real module so the pure helpers (Configuration,
// PKCE, authorize URL) keep working; only refreshTokenGrant is overridable.
let refreshGrantImpl:
  | ((
      ...args: Parameters<typeof realClient.refreshTokenGrant>
    ) => Promise<never>)
  | null = null;
mock.module("openid-client", () => ({
  ...realClient,
  refreshTokenGrant: (
    ...args: Parameters<typeof realClient.refreshTokenGrant>
  ) =>
    refreshGrantImpl
      ? refreshGrantImpl(...args)
      : realClient.refreshTokenGrant(...args),
}));

const {
  buildAuthorizeUrl,
  generatePkce,
  generateState,
  refreshTokens,
  OAuthError,
  OAUTH_CLIENT_ID,
  OAUTH_SCOPE,
} = await import("./oauth.ts");

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

  test("omits prompt by default", () => {
    const url = new URL(
      buildAuthorizeUrl({
        server: "https://api.example.com/",
        redirectUri: "http://127.0.0.1:54321/callback",
        codeChallenge: "abc123",
        state: "xyz",
      }),
    );
    expect(url.searchParams.has("prompt")).toBe(false);
  });

  test("includes prompt=login when passed (me login --switch)", () => {
    const url = new URL(
      buildAuthorizeUrl({
        server: "https://api.example.com/",
        redirectUri: "http://127.0.0.1:54321/callback",
        codeChallenge: "abc123",
        state: "xyz",
        prompt: "login",
      }),
    );
    expect(url.searchParams.get("prompt")).toBe("login");
  });
});

describe("refreshTokens error mapping", () => {
  test("adds per-process diagnostic headers to token requests", async () => {
    const originalFetch = globalThis.fetch;
    let request: Request | undefined;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        return new Response("{}", { status: 400 });
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;
    refreshGrantImpl = async (config) => {
      const customFetch = config[realClient.customFetch];
      expect(customFetch).toBeDefined();
      await customFetch?.("https://api.example.com/token", {
        body: undefined,
        headers: {},
        method: "POST",
        redirect: "manual",
      });
      throw new Error("stop after inspecting headers");
    };

    try {
      await refreshTokens({
        server: "https://api.example.com",
        refreshToken: "r1",
      });
    } catch {
      // The mock stops after exercising the custom fetch.
    } finally {
      refreshGrantImpl = null;
      globalThis.fetch = originalFetch;
    }

    expect(request?.headers.get("user-agent")).toBe(
      `memory-engine-cli/${CLIENT_VERSION}`,
    );
    expect(request?.headers.get("x-me-client-mode")).toBe("cli");
    expect(request?.headers.get("x-me-client-instance")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  test("maps an OAuth error response to OAuthError carrying the code", async () => {
    const rbe = new realClient.ResponseBodyError("token endpoint error", {
      cause: {
        error: "invalid_grant",
        error_description: "session not found",
      },
      response: new Response("{}", { status: 400 }),
    });
    // Sanity: oauth4webapi surfaces the OAuth code on `.error`.
    expect(rbe.error).toBe("invalid_grant");
    refreshGrantImpl = () => Promise.reject(rbe);

    let caught: unknown;
    try {
      await refreshTokens({
        server: "https://api.example.com",
        refreshToken: "r1",
      });
    } catch (error) {
      caught = error;
    } finally {
      refreshGrantImpl = null;
    }

    expect(caught).toBeInstanceOf(OAuthError);
    expect((caught as InstanceType<typeof OAuthError>).code).toBe(
      "invalid_grant",
    );
    // Prefers the server's human-readable description as the message.
    expect((caught as Error).message).toBe("session not found");
  });

  test("a non-OAuth (transport) failure has no code", async () => {
    refreshGrantImpl = () => Promise.reject(new Error("network down"));

    let caught: unknown;
    try {
      await refreshTokens({
        server: "https://api.example.com",
        refreshToken: "r1",
      });
    } catch (error) {
      caught = error;
    } finally {
      refreshGrantImpl = null;
    }

    expect(caught).toBeInstanceOf(OAuthError);
    expect((caught as InstanceType<typeof OAuthError>).code).toBeUndefined();
    expect((caught as Error).message).toBe("network down");
  });
});
