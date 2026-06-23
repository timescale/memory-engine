/**
 * Tests for the OAuth loopback redirect handler.
 *
 * Drives the in-process loopback server end-to-end: the fake `openBrowser`
 * stands in for the authorization server redirecting back to the bound
 * 127.0.0.1 port.
 */
import { describe, expect, test } from "bun:test";
import { LoopbackError, runLoopbackAuth } from "./oauth-loopback.ts";

describe("runLoopbackAuth", () => {
  test("resolves with the full callback URL on a successful redirect", async () => {
    let redirectUri = "";
    const callbackUrl = await runLoopbackAuth({
      authorizeUrl: (uri) => {
        redirectUri = uri;
        return `https://as.example/authorize?redirect_uri=${encodeURIComponent(uri)}`;
      },
      openBrowser: async () => {
        // The AS redirects the browser back to the loopback with the code.
        await fetch(`${redirectUri}?code=abc&state=xyz&iss=https%3A%2F%2Fas`);
      },
    });

    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const u = new URL(callbackUrl);
    expect(u.pathname).toBe("/callback");
    expect(u.searchParams.get("code")).toBe("abc");
    expect(u.searchParams.get("state")).toBe("xyz");
  });

  test("rejects with LoopbackError on an error redirect", async () => {
    let redirectUri = "";
    const promise = runLoopbackAuth({
      authorizeUrl: (uri) => {
        redirectUri = uri;
        return "https://as.example/authorize";
      },
      openBrowser: async () => {
        await fetch(
          `${redirectUri}?error=access_denied&error_description=Denied%20by%20user`,
        );
      },
    });

    await expect(promise).rejects.toThrow(LoopbackError);
    await expect(promise).rejects.toThrow(/Denied by user/);
  });

  test("times out waiting for the redirect", async () => {
    const promise = runLoopbackAuth({
      authorizeUrl: () => "https://as.example/authorize",
      openBrowser: async () => {}, // never redirects back
      timeoutMs: 100,
    });
    await expect(promise).rejects.toThrow(/Timed out/);
  });
});
