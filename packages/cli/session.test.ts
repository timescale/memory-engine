/**
 * Token-lifecycle tests for session.ts.
 *
 * Mocks the OAuth token endpoint (oauth.ts `refreshTokens`) and uses the real
 * file-fallback credential store (ME_NO_KEYCHAIN + an isolated XDG dir), so the
 * proactive/reactive refresh + rotation persistence are exercised end-to-end
 * without network or keychain.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
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

test("invalid_grant with no fresher stored token gives up", async () => {
  creds.storeTokens(SERVER, {
    access_token: "old",
    refresh_token: "r1",
    expires_at: Date.now() - 1_000,
  });
  refreshImpl = async () => {
    throw new OAuthError("session not found", "invalid_grant");
  };
  expect(await session.refreshAccessToken(SERVER)).toBeUndefined();
  // getAccessToken still falls back to the stale token (the 401 path is backstop).
  expect(await session.getAccessToken(SERVER)).toBe("old");
});

test("refreshFromStore uses the fallback refresh_token when the store is empty", async () => {
  // Contrived but reachable: another flow cleared the store between our
  // earlier read and the re-read (e.g. a concurrent `me logout`). The fallback
  // still carries our refresh_token, and refreshing with it must be possible.
  refreshImpl = async ({ refreshToken }) => {
    expect(refreshToken).toBe("r-fallback");
    return { accessToken: "new", refreshToken: "r-next", expiresIn: 3600 };
  };
  const result = await session.refreshFromStore(SERVER, {
    access_token: "old",
    refresh_token: "r-fallback",
    expires_at: Date.now() - 1_000,
  });
  expect(result?.access_token).toBe("new");
  expect(refreshCalls).toBe(1);
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
