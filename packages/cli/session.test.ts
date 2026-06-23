/**
 * Token-lifecycle tests for session.ts.
 *
 * Mocks the OAuth token endpoint (oauth.ts `refreshTokens`) and uses the real
 * file-fallback credential store (ME_NO_KEYCHAIN + an isolated XDG dir), so the
 * proactive/reactive refresh + rotation persistence are exercised end-to-end
 * without network or keychain.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = "https://api.example.com";

// Mock the OAuth protocol layer before importing session.ts.
let refreshCalls = 0;
let refreshImpl: (p: { server: string; refreshToken: string }) => Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
}>;

mock.module("./oauth.ts", () => ({
  refreshTokens: (p: { server: string; refreshToken: string }) => {
    refreshCalls++;
    return refreshImpl(p);
  },
}));

const creds = await import("./credentials.ts");
const session = await import("./session.ts");
const { resetKeychainForTests } = await import("./keychain.ts");

const ENV_KEYS = ["ME_SESSION_TOKEN", "XDG_CONFIG_HOME", "ME_NO_KEYCHAIN"];
let configDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  configDir = mkdtempSync(join(tmpdir(), "me-session-"));
  process.env.XDG_CONFIG_HOME = configDir;
  process.env.ME_NO_KEYCHAIN = "1";
  delete process.env.ME_SESSION_TOKEN;
  resetKeychainForTests();
  refreshCalls = 0;
  refreshImpl = async () => {
    throw new Error("unexpected refresh");
  };
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetKeychainForTests();
});

test("not logged in → undefined, no refresh", async () => {
  expect(await session.getAccessToken(SERVER)).toBeUndefined();
  expect(refreshCalls).toBe(0);
});

test("fresh token is returned without refreshing", async () => {
  creds.storeTokens(SERVER, {
    access_token: "fresh",
    refresh_token: "r1",
    expires_at: Date.now() + 3_600_000,
  });
  expect(await session.getAccessToken(SERVER)).toBe("fresh");
  expect(refreshCalls).toBe(0);
});

test("an expiring token is refreshed proactively and the rotation persisted", async () => {
  creds.storeTokens(SERVER, {
    access_token: "old",
    refresh_token: "r1",
    expires_at: Date.now() - 1_000, // already expired
  });
  refreshImpl = async () => ({
    accessToken: "new",
    refreshToken: "r2", // rotated
    expiresIn: 3600,
  });

  expect(await session.getAccessToken(SERVER)).toBe("new");
  expect(refreshCalls).toBe(1);

  // The rotated set is persisted: the new refresh token replaces the old, and
  // the new access token is now fresh (no further refresh).
  const stored = creds.getStoredTokens(SERVER);
  expect(stored?.access_token).toBe("new");
  expect(stored?.refresh_token).toBe("r2");
  expect(await session.getAccessToken(SERVER)).toBe("new");
  expect(refreshCalls).toBe(1);
});

test("a token with unknown expiry is trusted (no proactive refresh)", async () => {
  creds.storeTokens(SERVER, { access_token: "noexp", refresh_token: "r1" });
  expect(await session.getAccessToken(SERVER)).toBe("noexp");
  expect(refreshCalls).toBe(0);
});

test("ME_SESSION_TOKEN override is returned as-is and never refreshed", async () => {
  creds.storeTokens(SERVER, {
    access_token: "old",
    refresh_token: "r1",
    expires_at: Date.now() - 1_000,
  });
  process.env.ME_SESSION_TOKEN = "injected";
  expect(await session.getAccessToken(SERVER)).toBe("injected");
  expect(await session.refreshAccessToken(SERVER)).toBeUndefined();
  expect(refreshCalls).toBe(0);
});

test("refreshAccessToken forces a refresh; undefined without a refresh token", async () => {
  creds.storeTokens(SERVER, { access_token: "a" }); // no refresh token
  expect(await session.refreshAccessToken(SERVER)).toBeUndefined();
  expect(refreshCalls).toBe(0);

  creds.storeTokens(SERVER, { access_token: "a", refresh_token: "r1" });
  refreshImpl = async () => ({ accessToken: "b", refreshToken: "r2" });
  expect(await session.refreshAccessToken(SERVER)).toBe("b");
  expect(refreshCalls).toBe(1);
});

test("a failed refresh falls back to the current token", async () => {
  creds.storeTokens(SERVER, {
    access_token: "stale",
    refresh_token: "r1",
    expires_at: Date.now() - 1_000,
  });
  refreshImpl = async () => {
    throw new Error("invalid_grant");
  };
  // getAccessToken falls back to the stale token (the 401 path is the backstop).
  expect(await session.getAccessToken(SERVER)).toBe("stale");
  // refreshAccessToken reports the failure as undefined.
  expect(await session.refreshAccessToken(SERVER)).toBeUndefined();
});

test("concurrent expiring reads share a single refresh round-trip", async () => {
  creds.storeTokens(SERVER, {
    access_token: "old",
    refresh_token: "r1",
    expires_at: Date.now() - 1_000,
  });
  let resolve: (v: {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  }) => void = () => {};
  refreshImpl = () =>
    new Promise((res) => {
      resolve = res;
    });

  const a = session.getAccessToken(SERVER);
  const b = session.getAccessToken(SERVER);
  // Both in-flight against one refresh; release it.
  resolve({ accessToken: "new", refreshToken: "r2", expiresIn: 3600 });
  expect(await a).toBe("new");
  expect(await b).toBe("new");
  expect(refreshCalls).toBe(1);
});
