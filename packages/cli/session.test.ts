/**
 * Token-lifecycle tests for session.ts.
 *
 * Mocks the OAuth token endpoint (oauth.ts `refreshTokens`) and uses the real
 * file-fallback credential store (ME_NO_KEYCHAIN + an isolated XDG dir), so the
 * proactive/reactive refresh + rotation persistence are exercised end-to-end
 * without network or keychain.
 */
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthTokenSet } from "./credentials.ts";

const SERVER = "https://api.example.com";

// Mock the OAuth protocol layer before importing session.ts.
let refreshCalls = 0;
let refreshImpl: (p: { server: string; refreshToken: string }) => Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
}>;

// The real OAuthError class, re-exported through the mock so session.ts's
// `error instanceof OAuthError` check keys on the same identity our test throws.
const { OAuthError } = await import("./oauth.ts");

mock.module("./oauth.ts", () => ({
  refreshTokens: (p: { server: string; refreshToken: string }) => {
    refreshCalls++;
    return refreshImpl(p);
  },
  OAuthError,
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

// =============================================================================
// Track A — cross-process serialization: re-read the store instead of replaying
// =============================================================================

test("refreshFromStore returns a peer-rotated token without a network call", async () => {
  // The store already holds a peer's rotated token (r1 → r2); our snapshot is r1.
  creds.storeTokens(SERVER, {
    access_token: "peer",
    refresh_token: "r2",
    expires_at: Date.now() + 3_600_000,
  });
  const result = await session.refreshFromStore(SERVER, {
    access_token: "old",
    refresh_token: "r1",
    expires_at: Date.now() - 1_000,
  });
  expect(result?.access_token).toBe("peer");
  expect(result?.refresh_token).toBe("r2");
  expect(refreshCalls).toBe(0); // no replay of the now-revoked r1
});

test("refreshFromStore refreshes when the store still holds our refresh token", async () => {
  creds.storeTokens(SERVER, {
    access_token: "old",
    refresh_token: "r1",
    expires_at: Date.now() - 1_000,
  });
  refreshImpl = async () => ({
    accessToken: "new",
    refreshToken: "r2",
    expiresIn: 3600,
  });
  const result = await session.refreshFromStore(SERVER, {
    access_token: "old",
    refresh_token: "r1",
    expires_at: Date.now() - 1_000,
  });
  expect(result?.access_token).toBe("new");
  expect(refreshCalls).toBe(1);
});

test("withRefreshLock serializes concurrent actions for one server", async () => {
  let active = 0;
  let maxActive = 0;
  const action = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return "ok";
  };
  const results = await Promise.all([
    session.withRefreshLock(SERVER, action),
    session.withRefreshLock(SERVER, action),
    session.withRefreshLock(SERVER, action),
  ]);
  expect(results).toEqual(["ok", "ok", "ok"]);
  expect(maxActive).toBe(1); // never two refreshes in flight at once
});

test("withRefreshLock reclaims a stale lock left by a crashed holder", async () => {
  const lock = session.lockPath(SERVER);
  mkdirSync(lock, { recursive: true });
  const stale = new Date(Date.now() - 60_000); // older than LOCK_STALE_MS
  utimesSync(lock, stale, stale);
  const result = await session.withRefreshLock(SERVER, async () => "ran");
  expect(result).toBe("ran");
});

test("withRefreshLock returns LOCK_TIMEOUT when a live holder holds past the deadline", async () => {
  const lock = session.lockPath(SERVER);
  mkdirSync(lock, { recursive: true }); // simulate a live holder
  try {
    const result = await session.withRefreshLock(SERVER, async () => "ran", {
      acquireTimeoutMs: 50, // give up fast
      staleMs: 60_000, // never reclaim as stale
      pollMs: 5,
    });
    expect(result).toBe(session.LOCK_TIMEOUT);
  } finally {
    rmdirSync(lock);
  }
});

test("withRefreshLock releases the lock even when the action throws", async () => {
  await expect(
    session.withRefreshLock(SERVER, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  // A subsequent acquire proves the lock was released in the finally.
  const result = await session.withRefreshLock(SERVER, async () => "ok");
  expect(result).toBe("ok");
});

test("withRefreshLock serializes across processes (real cross-process lock)", async () => {
  // The whole point of the file lock: two SEPARATE OS processes on one host
  // must not run their actions concurrently. Single-process Promise.all only
  // exercises the algorithm; this exercises the actual mkdir syscall gate.
  const childPath = join(configDir, "child.ts");
  const sessionPath = join(import.meta.dir, "session.ts");
  // Child prints wall-clock [enter, exit] timestamps for its critical section,
  // so the parent can verify non-overlap across processes.
  writeFileSync(
    childPath,
    `import { withRefreshLock } from ${JSON.stringify(sessionPath)};
const SERVER = ${JSON.stringify(SERVER)};
await withRefreshLock(SERVER, async () => {
  const enter = Date.now();
  await new Promise((r) => setTimeout(r, 150));
  const exit = Date.now();
  console.log(JSON.stringify({ enter, exit }));
});
`,
  );

  const spawnChild = () =>
    Bun.spawn([process.execPath, childPath], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configDir,
        ME_NO_KEYCHAIN: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

  const [a, b] = [spawnChild(), spawnChild()];
  const [aOut, bOut, aErr, bErr] = await Promise.all([
    new Response(a.stdout).text(),
    new Response(b.stdout).text(),
    new Response(a.stderr).text(),
    new Response(b.stderr).text(),
  ]);
  const [aExit, bExit] = await Promise.all([a.exited, b.exited]);
  expect(aExit, `child a failed: ${aErr}`).toBe(0);
  expect(bExit, `child b failed: ${bErr}`).toBe(0);

  const parse = (out: string) =>
    JSON.parse(out.trim()) as { enter: number; exit: number };
  const winA = parse(aOut);
  const winB = parse(bOut);

  // Serialization invariant: the earlier window closes before the later opens.
  // (Wall-clock timestamps are comparable across processes on the same host.)
  const [earlier, later] =
    winA.enter <= winB.enter ? [winA, winB] : [winB, winA];
  expect(later.enter).toBeGreaterThanOrEqual(earlier.exit);
}, 15_000);

test("concurrent reclaimers of a stale lock still serialize (race-safe)", async () => {
  const lock = session.lockPath(SERVER);
  mkdirSync(lock, { recursive: true });
  const stale = new Date(Date.now() - 60_000);
  utimesSync(lock, stale, stale);

  let active = 0;
  let maxActive = 0;
  const action = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return "ok";
  };
  const results = await Promise.all([
    session.withRefreshLock(SERVER, action, {
      acquireTimeoutMs: 5_000,
      staleMs: 30_000,
      pollMs: 5,
    }),
    session.withRefreshLock(SERVER, action, {
      acquireTimeoutMs: 5_000,
      staleMs: 30_000,
      pollMs: 5,
    }),
    session.withRefreshLock(SERVER, action, {
      acquireTimeoutMs: 5_000,
      staleMs: 30_000,
      pollMs: 5,
    }),
  ]);
  // Both winners of the reclaim race + any polling waiters all run — but never
  // in parallel; the raw mkdir gate holds.
  expect(results).toEqual(["ok", "ok", "ok"]);
  expect(maxActive).toBe(1);
});

test("heartbeat prevents reclaiming a slow live holder", async () => {
  let firstDone = false;
  const first = session.withRefreshLock(
    SERVER,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      firstDone = true;
      return "first";
    },
    { acquireTimeoutMs: 300, staleMs: 30, pollMs: 5, heartbeatMs: 5 },
  );
  // Let the first holder acquire before contending for its lock.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = session.withRefreshLock(
    SERVER,
    async () => {
      expect(firstDone).toBe(true); // must not run after a stale takeover
      return "second";
    },
    { acquireTimeoutMs: 300, staleMs: 30, pollMs: 5, heartbeatMs: 5 },
  );

  expect(await first).toBe("first");
  expect(await second).toBe("second");
});

test("a reclaimed owner cannot remove its successor's lock", async () => {
  const lock = session.lockPath(SERVER);
  const stalePath = `${lock}.test-stale`;
  try {
    await session.withRefreshLock(
      SERVER,
      async () => {
        // Simulate a stale handoff while the old owner is still unwinding.
        renameSync(lock, stalePath);
        mkdirSync(lock);
        writeFileSync(join(lock, "owner"), "successor");
        return "old";
      },
      { heartbeatMs: 5 },
    );

    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(join(lock, "owner"), "utf-8")).toBe("successor");
  } finally {
    rmSync(lock, { recursive: true, force: true });
    rmSync(stalePath, { recursive: true, force: true });
  }
});

// =============================================================================
// Track B — invalid_grant recovery: re-read a peer/prior fresh set before
// forcing a re-login; distinguish a dead token from a transient failure.
// =============================================================================

test("invalid_grant recovers a concurrently-persisted fresh token", async () => {
  creds.storeTokens(SERVER, {
    access_token: "old",
    refresh_token: "r1",
    expires_at: Date.now() - 1_000,
  });
  refreshImpl = async () => {
    // A peer rotated + persisted before our own exchange came back invalid_grant
    // (the losing side of a race, or a lost response from a prior refresh).
    creds.storeTokens(SERVER, {
      access_token: "peer",
      refresh_token: "r2",
      expires_at: Date.now() + 3_600_000,
    });
    throw new OAuthError("session not found", "invalid_grant");
  };
  expect(await session.refreshAccessToken(SERVER)).toBe("peer");
  expect(refreshCalls).toBe(1);
});

test("invalid_grant refreshes with a peer's newer token when its access token is stale", async () => {
  creds.storeTokens(SERVER, {
    access_token: "old",
    refresh_token: "r1",
    expires_at: Date.now() - 1_000,
  });
  refreshImpl = async ({ refreshToken }) => {
    if (refreshToken === "r1") {
      creds.storeTokens(SERVER, {
        access_token: "peer-old",
        refresh_token: "r2",
        expires_at: Date.now() - 1_000,
      });
      throw new OAuthError("session not found", "invalid_grant");
    }
    expect(refreshToken).toBe("r2");
    return { accessToken: "fresh", refreshToken: "r3", expiresIn: 3600 };
  };

  expect(await session.refreshAccessToken(SERVER)).toBe("fresh");
  expect(refreshCalls).toBe(2);
});

test("proactive invalid_grant is terminal for reactive and future normalized-origin calls", async () => {
  creds.storeTokens(SERVER, {
    access_token: "old",
    refresh_token: "r1",
    expires_at: Date.now() - 1_000,
  });
  refreshImpl = async () => {
    throw new OAuthError("session not found", "invalid_grant");
  };
  await expect(session.getAccessToken(SERVER)).rejects.toThrow(
    session.ReLoginRequiredError,
  );
  for (const origin of [
    SERVER,
    `${SERVER}/`,
    "https://api.example.com:443/path",
  ]) {
    await expect(session.refreshAccessToken(origin)).rejects.toThrow(
      "me login",
    );
    await expect(session.getAccessToken(origin)).rejects.toThrow("me login");
  }
  expect(refreshCalls).toBe(1);
  const stored = creds.getStoredTokens(SERVER);
  expect(stored?.refresh_token).toBeUndefined();
  expect(stored?.refresh_rejected).toMatch(/^[a-f0-9]{64}$/);
  expect(
    readFileSync(join(configDir, "me", "credentials.yaml"), "utf-8"),
  ).not.toContain("r1");
});

test("refreshFromStore never resurrects a cleared fallback refresh_token", async () => {
  // A concurrent logout cleared the snapshot; never restore it from fallback.
  const result = await session.refreshFromStore(SERVER, {
    access_token: "old",
    refresh_token: "r-fallback",
    expires_at: Date.now() - 1_000,
  });
  expect(result).toBeUndefined();
  expect(refreshCalls).toBe(0);
  expect(creds.getStoredTokens(SERVER)).toBeUndefined();
});

test("refreshFromStore refreshes with peer's refresh_token when peer's set is stale", async () => {
  // Peer rotated long enough ago that its access_token is also expiring. We
  // MUST refresh with peer's r2 (the current, valid rotation), never our own
  // r1 (which peer's rotation revoked). Mirrors the invalid_grant recovery.
  creds.storeTokens(SERVER, {
    access_token: "peer-old",
    refresh_token: "r2",
    expires_at: Date.now() - 1_000,
  });
  let calledWith: string | undefined;
  refreshImpl = async ({ refreshToken }) => {
    calledWith = refreshToken;
    return { accessToken: "fresh", refreshToken: "r3", expiresIn: 3600 };
  };
  const result = await session.refreshFromStore(SERVER, {
    access_token: "old",
    refresh_token: "r1", // our now-revoked token
    expires_at: Date.now() - 1_000,
  });
  expect(result?.access_token).toBe("fresh");
  expect(calledWith).toBe("r2"); // NOT r1
});

test("a failed refresh clears the in-flight entry so a retry makes a fresh call", async () => {
  creds.storeTokens(SERVER, {
    access_token: "old",
    refresh_token: "r1",
    expires_at: Date.now() - 1_000,
  });
  let calls = 0;
  refreshImpl = async () => {
    calls++;
    if (calls === 1) throw new Error("transient");
    return { accessToken: "new", refreshToken: "r2", expiresIn: 3600 };
  };
  // First call: refresh fails, getAccessToken falls back to the stale token.
  expect(await session.getAccessToken(SERVER)).toBe("old");
  expect(calls).toBe(1);
  // Second call: must re-run refresh (not stuck on the prior failed in-flight).
  expect(await session.getAccessToken(SERVER)).toBe("new");
  expect(calls).toBe(2);
});

test("persisted rejection blocks a separate process without network/keychain access", async () => {
  creds.storeTokens(SERVER, {
    access_token: "old",
    refresh_token: "dead-refresh",
    expires_at: 0,
  });
  refreshImpl = async () => {
    throw new OAuthError("untrusted token endpoint text", "invalid_grant");
  };
  await expect(session.getAccessToken(SERVER)).rejects.toThrow("me login");
  const childPath = join(configDir, "rejected-child.ts");
  writeFileSync(
    childPath,
    `
import { getAccessToken, refreshAccessToken } from ${JSON.stringify(join(import.meta.dir, "session.ts"))};
globalThis.fetch = () => { throw new Error("network must not be called"); };
for (const get of [getAccessToken, refreshAccessToken]) {
  try { await get(${JSON.stringify(`${SERVER}:443/`)}); process.exit(2); }
  catch (e) { console.log(e.message); }
}
`,
  );
  const child = Bun.spawn([process.execPath, childPath], {
    env: { ...process.env, ME_NO_KEYCHAIN: "1", XDG_CONFIG_HOME: configDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, err).toBe(0);
  expect(out.match(/me login/g)?.length).toBe(2);
  expect(out).not.toContain("dead-refresh");
  expect(out).not.toContain("untrusted");
  expect(refreshCalls).toBe(1);
});

test("re-login replaces rejection and a new origin is unaffected", async () => {
  creds.storeTokens(SERVER, {
    access_token: "old",
    refresh_token: "dead",
    expires_at: 0,
  });
  refreshImpl = async () => {
    throw new OAuthError("rejected", "invalid_grant");
  };
  await expect(session.getAccessToken(SERVER)).rejects.toThrow("me login");
  const other = "https://other.example.com";
  creds.storeTokens(other, {
    access_token: "other",
    refresh_token: "other-refresh",
    expires_at: 0,
  });
  refreshImpl = async () => ({
    accessToken: "other-new",
    refreshToken: "other-next",
    expiresIn: 3600,
  });
  expect(await session.getAccessToken(other)).toBe("other-new");
  creds.storeTokens(`${SERVER}/`, {
    access_token: "login",
    refresh_token: "login-refresh",
    expires_at: 0,
  });
  expect(creds.getStoredTokens(SERVER)?.refresh_rejected).toBeUndefined();
  refreshImpl = async ({ refreshToken }) => {
    expect(refreshToken).toBe("login-refresh");
    return {
      accessToken: "recovered",
      refreshToken: "rotated",
      expiresIn: 3600,
    };
  };
  expect(await session.getAccessToken(SERVER)).toBe("recovered");
  expect(refreshCalls).toBe(3);
});

test("rejection does not defeat injected session/API key overrides", async () => {
  creds.storeTokens(SERVER, {
    access_token: "old",
    refresh_token: "dead",
    expires_at: 0,
  });
  refreshImpl = async () => {
    throw new OAuthError("rejected", "invalid_grant");
  };
  await expect(session.refreshAccessToken(SERVER)).rejects.toThrow("me login");
  process.env.ME_SESSION_TOKEN = "injected";
  expect(await session.getAccessToken(SERVER)).toBe("injected");
  expect(await session.refreshAccessToken(SERVER)).toBeUndefined();
  delete process.env.ME_SESSION_TOKEN;
  for (const bearer of [
    session.userBearer(SERVER, "api-key"),
    session.memoryBearer(SERVER, "api-key"),
  ]) {
    expect(await bearer.getToken()).toBe("api-key");
    expect(await bearer.onUnauthorized()).toBeUndefined();
  }
  expect(refreshCalls).toBe(1);
});

test("concurrent proactive/reactive rejections share a lock and one exchange", async () => {
  creds.storeTokens(SERVER, {
    access_token: "old",
    refresh_token: "dead",
    expires_at: 0,
  });
  refreshImpl = async () => {
    throw new OAuthError("rejected", "invalid_grant");
  };
  const results = await Promise.allSettled([
    session.getAccessToken(SERVER),
    session.getAccessToken(`${SERVER}/`),
    session.refreshAccessToken(SERVER),
  ]);
  expect(
    results.every(
      (r) =>
        r.status === "rejected" &&
        r.reason instanceof session.ReLoginRequiredError,
    ),
  ).toBe(true);
  expect(refreshCalls).toBe(1);
  expect(await session.withRefreshLock(SERVER, async () => "released")).toBe(
    "released",
  );
  await expect(
    session.refreshFromStore(SERVER, {
      access_token: "snapshot",
      refresh_token: "dead",
    }),
  ).rejects.toThrow("me login");
  expect(refreshCalls).toBe(1);
});

test("transient OAuth errors retain credentials and retry through reactive path", async () => {
  const tokens = { access_token: "old", refresh_token: "live", expires_at: 0 };
  creds.storeTokens(SERVER, tokens);
  refreshImpl = async () => {
    throw new OAuthError("temporarily unavailable", "server_error");
  };
  expect(await session.getAccessToken(SERVER)).toBe("old");
  expect(await session.refreshAccessToken(SERVER)).toBeUndefined();
  expect(creds.getStoredTokens(SERVER)).toEqual(tokens);
  refreshImpl = async () => ({
    accessToken: "new",
    refreshToken: "next",
    expiresIn: 3600,
  });
  expect(await session.refreshAccessToken(SERVER)).toBe("new");
  expect(refreshCalls).toBe(3);
});

for (const destination of ["keychain", "file"] as const) {
  test(`successful rotation survives unavailable keychain reread via ${destination} persistence`, async () => {
    const keychain = await import("./keychain.ts");
    let tokens: OAuthTokenSet = {
      access_token: "old",
      refresh_token: "spent-r1",
      expires_at: 0,
    };
    let unavailable = false;
    const read = spyOn(keychain, "keychainRead").mockImplementation(() =>
      unavailable
        ? { status: "unavailable" }
        : { status: "found", value: JSON.stringify(tokens) },
    );
    const write = spyOn(keychain, "keychainSet").mockImplementation(
      (_origin, raw) => {
        if (destination === "file") return false;
        tokens = JSON.parse(raw) as OAuthTokenSet;
        return true;
      },
    );
    refreshImpl = async ({ refreshToken }) => {
      expect(refreshToken).toBe("spent-r1");
      unavailable = true;
      return {
        accessToken: "new-access",
        refreshToken: "rotated-r2",
        expiresIn: 3600,
      };
    };
    try {
      expect(await session.getAccessToken(SERVER)).toBe("new-access");
      unavailable = false;
      expect(creds.readStoredTokens(SERVER)).toMatchObject({
        status: "found",
        tokens: { access_token: "new-access", refresh_token: "rotated-r2" },
      });
      expect(await session.getAccessToken(SERVER)).toBe("new-access");
      expect(refreshCalls).toBe(1);
    } finally {
      write.mockRestore();
      read.mockRestore();
    }
  });
}

test("successful rotation with unwritable persistence fails terminally instead of replaying its consumed token", async () => {
  creds.storeTokens(SERVER, {
    access_token: "old",
    refresh_token: "spent-r1",
    expires_at: 0,
  });
  const write = spyOn(creds, "storeTokens").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  refreshImpl = async () => ({
    accessToken: "new-access",
    refreshToken: "rotated-r2",
    expiresIn: 3600,
  });
  try {
    await expect(session.getAccessToken(SERVER)).rejects.toBeInstanceOf(
      session.ReLoginRequiredError,
    );
    await expect(session.refreshAccessToken(SERVER)).rejects.toBeInstanceOf(
      session.ReLoginRequiredError,
    );
    await expect(session.getAccessToken(SERVER)).rejects.toBeInstanceOf(
      session.ReLoginRequiredError,
    );
    expect(refreshCalls).toBe(1);
  } finally {
    write.mockRestore();
  }
});

test("a successful exchange cannot overwrite a peer login or resurrect logout", async () => {
  for (const peer of [
    undefined,
    { access_token: "peer", refresh_token: "peer-refresh" },
  ]) {
    creds.storeTokens(SERVER, {
      access_token: "old",
      refresh_token: peer ? "old-refresh-login" : "old-refresh-logout",
      expires_at: 0,
    });
    refreshImpl = async () => {
      if (peer) creds.storeTokens(SERVER, peer);
      else creds.clearTokens(SERVER);
      return {
        accessToken: "late",
        refreshToken: "late-refresh",
        expiresIn: 3600,
      };
    };
    expect(await session.getAccessToken(SERVER)).toBe(peer?.access_token);
    expect(creds.getStoredTokens(SERVER)).toEqual(peer);
  }
});

test("reactive rejection crosses the real transport without network retries or losing the re-login error", async () => {
  const { createUserClient } = await import("./client.ts");
  creds.storeTokens(SERVER, {
    access_token: "initially-fresh",
    refresh_token: "dead",
    expires_at: Date.now() + 3_600_000,
  });
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  globalThis.fetch = (async () => {
    rpcCalls++;
    return new Response("{}", { status: 401 });
  }) as unknown as typeof fetch;
  refreshImpl = async () => {
    throw new OAuthError("untrusted secret text", "invalid_grant");
  };
  try {
    const client = createUserClient({
      url: SERVER,
      ...session.userBearer(SERVER),
      retries: 2,
    });
    await expect(client.whoami()).rejects.toThrow(session.ReLoginRequiredError);
    // The proactive layer of the next RPC throws from persisted state, too.
    await expect(client.whoami()).rejects.toThrow("me login");
    expect(rpcCalls).toBe(1);
    expect(refreshCalls).toBe(1);
    expect(creds.getStoredTokens(SERVER)?.refresh_rejected).toBeDefined();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const mode of ["before", "after"] as const) {
  test(`invalid_grant remains terminal when credential persistence fails ${mode} writing`, async () => {
    creds.storeTokens(SERVER, {
      access_token: "old",
      refresh_token: "rejected-r1",
      expires_at: Date.now() - 1000,
    });
    const originalStore = creds.storeTokens;
    const write = spyOn(creds, "storeTokens").mockImplementation(
      (server, tokens) => {
        if (mode === "after") originalStore(server, tokens);
        throw new Error("credential persistence unavailable");
      },
    );
    refreshImpl = async () => {
      throw new OAuthError("session not found", "invalid_grant");
    };
    try {
      await expect(session.getAccessToken(SERVER)).rejects.toBeInstanceOf(
        session.ReLoginRequiredError,
      );
      await expect(
        session.refreshAccessToken(`${SERVER}/`),
      ).rejects.toBeInstanceOf(session.ReLoginRequiredError);
      await expect(session.getAccessToken(SERVER)).rejects.toBeInstanceOf(
        session.ReLoginRequiredError,
      );
      expect(refreshCalls).toBe(1);
    } finally {
      write.mockRestore();
    }
    // The local fallback is token-specific, not an origin-wide login ban.
    creds.storeTokens(SERVER, {
      access_token: "new-login",
      refresh_token: "new-r2",
      expires_at: Date.now() + 3600000,
    });
    expect(await session.getAccessToken(SERVER)).toBe("new-login");
    expect(refreshCalls).toBe(1);
  });
}

test("logout during invalid_grant does not resurrect the rejected snapshot", async () => {
  creds.storeTokens(SERVER, {
    access_token: "old",
    refresh_token: "dead",
    expires_at: 0,
  });
  refreshImpl = async () => {
    creds.clearTokens(SERVER);
    throw new OAuthError("rejected", "invalid_grant");
  };
  await expect(session.getAccessToken(SERVER)).rejects.toThrow("me login");
  expect(creds.getStoredTokens(SERVER)).toBeUndefined();
  expect(await session.getAccessToken(SERVER)).toBeUndefined();
  expect(refreshCalls).toBe(1);
});

test("keychain empty reread after invalid_grant still guards the rejected token when lookup recovers", async () => {
  const keychain = await import("./keychain.ts");
  const tokens = {
    access_token: "old-keychain",
    refresh_token: "dead-keychain",
    expires_at: 0,
  };
  let unavailable = false;
  const lookup = spyOn(keychain, "keychainRead").mockImplementation(() =>
    unavailable
      ? { status: "unavailable" }
      : { status: "found", value: JSON.stringify(tokens) },
  );
  refreshImpl = async () => {
    unavailable = true;
    throw new OAuthError("revoked", "invalid_grant");
  };
  try {
    await expect(session.getAccessToken(SERVER)).rejects.toThrow("me login");
    unavailable = false;
    await expect(session.getAccessToken(SERVER)).rejects.toThrow("me login");
    await expect(session.refreshAccessToken(SERVER)).rejects.toThrow(
      "me login",
    );
    expect(refreshCalls).toBe(1);
    // No matching stored record at rejection time: never persist a snapshot.
    expect(creds.getServerSecrets(SERVER).tokens).toBeUndefined();
  } finally {
    lookup.mockRestore();
  }
});

for (const rejected of [false, true]) {
  test(`background ${rejected ? "rejection" : "rotation"} does not change default server`, async () => {
    creds.storeTokens(SERVER, {
      access_token: "old",
      refresh_token: "r1",
      expires_at: 0,
    });
    const selected = "https://selected.example.com";
    creds.setDefaultServer(selected);
    refreshImpl = async () => {
      if (rejected) throw new OAuthError("revoked", "invalid_grant");
      return { accessToken: "rotated", refreshToken: "r2", expiresIn: 3600 };
    };
    if (rejected)
      await expect(session.getAccessToken(SERVER)).rejects.toThrow("me login");
    else expect(await session.getAccessToken(SERVER)).toBe("rotated");
    expect(creds.resolveServer()).toBe(selected);
  });
}

test("reactive transport recovers a fresh access-only login completed while waiting for the lock", async () => {
  const { createUserClient } = await import("./client.ts");
  creds.storeTokens(SERVER, {
    access_token: "old",
    refresh_token: "old-refresh",
  });
  let unlock!: () => void;
  let held!: () => void;
  const acquired = new Promise<void>((resolve) => {
    held = resolve;
  });
  const release = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const holder = session.withRefreshLock(SERVER, async () => {
    held();
    await release;
    creds.storeTokens(SERVER, { access_token: "fresh-device" });
  });
  await acquired;
  const originalRead = creds.getStoredTokens;
  let reactiveRead!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reactiveRead = resolve;
  });
  let reads = 0;
  const read = spyOn(creds, "getStoredTokens").mockImplementation((server) => {
    if (++reads === 2) reactiveRead(); // proactive read, then reactive snapshot
    return originalRead(server);
  });
  const identity = {
    id: "device-user",
    kind: "u" as const,
    email: null,
    name: "Device user",
  };
  const originalFetch = globalThis.fetch;
  const bearers: (string | null)[] = [];
  globalThis.fetch = (async (_url, init) => {
    bearers.push(new Headers(init?.headers).get("Authorization"));
    if (bearers.length === 1) return new Response("{}", { status: 401 });
    return Response.json({ jsonrpc: "2.0", id: 1, result: identity });
  }) as typeof fetch;
  try {
    const client = createUserClient({
      url: SERVER,
      ...session.userBearer(SERVER),
      retries: 0,
    });
    const result = client.whoami();
    await waiting;
    unlock();
    await holder;
    await expect(result).resolves.toEqual(identity);
    expect(bearers).toEqual(["Bearer old", "Bearer fresh-device"]);
    expect(refreshCalls).toBe(0); // never replay old-refresh
  } finally {
    unlock();
    await holder;
    read.mockRestore();
    globalThis.fetch = originalFetch;
  }
});
