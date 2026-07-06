/**
 * Tests for the OAuth loopback redirect handler.
 *
 * Drives the in-process loopback server end-to-end: the fake `openBrowser`
 * stands in for the authorization server redirecting back to the bound
 * 127.0.0.1 port.
 */
import { describe, expect, test } from "bun:test";
import {
  LoopbackError,
  runLoopbackAuth,
  successPage,
} from "./oauth-loopback.ts";

describe("successPage", () => {
  test("links to the UI when a uiUrl is provided", async () => {
    const html = await successPage("http://localhost:3000").text();
    expect(html).toContain('href="http://localhost:3000"');
    expect(html).toContain("Open the Memory Engine UI");
  });

  test("keeps the auth code out of the Referer via rel=noreferrer", async () => {
    const html = await successPage("http://localhost:3000").text();
    expect(html).toContain('rel="noreferrer"');
  });

  test("omits the link when no uiUrl is provided", async () => {
    const html = await successPage().text();
    expect(html).not.toContain("<a href");
    expect(html).toContain("close this tab");
  });

  test("omits the link for non-http(s) schemes", async () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<h1>x</h1>",
      "not a url",
    ]) {
      const html = await successPage(bad).text();
      expect(html).not.toContain("<a href");
      expect(html).toContain("close this tab");
    }
  });

  test("HTML-escapes the uiUrl", async () => {
    const html = await successPage(
      'https://x.example/"><script>alert(1)</script>',
    ).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

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
