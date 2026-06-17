// Unit tests for the browser (hosted-UI) login/logout handlers. These don't
// touch the network or a DB: loginInitiate just builds a provider URL + stores
// a verification, and logout clears the cookie + revokes the session. The OAuth
// callback's success path (which calls the providers) is exercised manually /
// e2e; here we cover the handler glue with a mock AuthStore.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { AuthStore } from "@memory.build/auth";
import {
  type AuthHandlerContext,
  loginInitiateHandler,
  logoutHandler,
} from "./auth";

const saved = {
  id: process.env.GITHUB_CLIENT_ID,
  secret: process.env.GITHUB_CLIENT_SECRET,
};

beforeAll(() => {
  // buildAuthUrl(github) reads these; values are irrelevant to the assertions.
  process.env.GITHUB_CLIENT_ID = "test-client-id";
  process.env.GITHUB_CLIENT_SECRET = "test-client-secret";
});

afterAll(() => {
  for (const [k, v] of [
    ["GITHUB_CLIENT_ID", saved.id],
    ["GITHUB_CLIENT_SECRET", saved.secret],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function ctxWith(
  auth: Partial<AuthStore>,
  baseUrl = "https://app.example.com",
): AuthHandlerContext {
  return {
    auth,
    db: {},
    authSchema: "auth",
    coreSchema: "core",
    baseUrl,
    allowedOrigins: ["https://app.example.com"],
  } as unknown as AuthHandlerContext;
}

/** Same-origin signal the SPA's fetch carries, so logout passes the CSRF gate. */
const SAME_ORIGIN = { Origin: "https://app.example.com" };

describe("loginInitiateHandler", () => {
  test("creates a verification (with a browser-binding nonce) and 302s to the provider", async () => {
    const calls: Array<{ id: string; value: string }> = [];
    const auth = {
      createVerification: mock(async (id: string, value: string) => {
        calls.push({ id, value });
      }),
    };

    const res = await loginInitiateHandler(
      new Request("http://x/api/v1/auth/login/github?redirect=/memory/abc"),
      { provider: "github" },
      ctxWith(auth),
    );

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("github.com/login/oauth/authorize");

    const state = new URL(loc).searchParams.get("state") ?? "";
    expect(state).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe(state);
    const stored = JSON.parse(calls[0]?.value ?? "{}");
    expect(stored.provider).toBe("github");
    expect(stored.redirectTo).toBe("/memory/abc");
    expect(typeof stored.nonce).toBe("string");
    expect(stored.nonce.length).toBeGreaterThan(0);

    // The nonce is also set as a browser cookie (secure base URL → __Host-),
    // and it matches the stored nonce so the callback can bind them.
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain(`__Host-me_login=${stored.nonce}`);
  });

  test("rejects an unknown provider with 400 and no verification", async () => {
    const auth = { createVerification: mock(async () => {}) };
    const res = await loginInitiateHandler(
      new Request("http://x/api/v1/auth/login/twitter"),
      { provider: "twitter" },
      ctxWith(auth),
    );
    expect(res.status).toBe(400);
    expect(auth.createVerification).not.toHaveBeenCalled();
  });

  test("sanitizes an off-site redirect to /", async () => {
    const values: string[] = [];
    const auth = {
      createVerification: mock(async (_id: string, value: string) => {
        values.push(value);
      }),
    };
    await loginInitiateHandler(
      new Request(
        "http://x/api/v1/auth/login/github?redirect=//evil.example.com",
      ),
      { provider: "github" },
      ctxWith(auth),
    );
    expect(JSON.parse(values[0] ?? "{}").redirectTo).toBe("/");
  });
});

describe("logoutHandler", () => {
  test("revokes the session and clears the cookie (secure → __Host-)", async () => {
    const auth = { deleteSessionByToken: mock(async () => true) };
    const res = await logoutHandler(
      new Request("http://x/api/v1/auth/logout", {
        method: "POST",
        headers: { ...SAME_ORIGIN, Cookie: "__Host-me_session=tok" },
      }),
      ctxWith(auth),
    );
    expect(res.status).toBe(200);
    expect(auth.deleteSessionByToken).toHaveBeenCalledWith("tok");
    const cookies = res.headers.getSetCookie();
    // Secure mode clears both the __Host- and the plain fallback name.
    expect(
      cookies.some(
        (c) => c.includes("__Host-me_session=") && c.includes("Max-Age=0"),
      ),
    ).toBe(true);
    expect(cookies.some((c) => c.startsWith("me_session="))).toBe(true);
  });

  test("no cookie → still 200 + clears, without a delete call", async () => {
    const auth = { deleteSessionByToken: mock(async () => true) };
    const res = await logoutHandler(
      new Request("http://x/api/v1/auth/logout", {
        method: "POST",
        headers: SAME_ORIGIN,
      }),
      ctxWith(auth),
    );
    expect(res.status).toBe(200);
    expect(auth.deleteSessionByToken).not.toHaveBeenCalled();
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  test("rejects a cross-origin logout (CSRF gate) without touching the session", async () => {
    const auth = { deleteSessionByToken: mock(async () => true) };
    const res = await logoutHandler(
      new Request("http://x/api/v1/auth/logout", {
        method: "POST",
        headers: {
          Origin: "https://evil.example.com",
          Cookie: "__Host-me_session=tok",
        },
      }),
      ctxWith(auth),
    );
    expect(res.status).toBe(403);
    expect(auth.deleteSessionByToken).not.toHaveBeenCalled();
  });
});
