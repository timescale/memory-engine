/** Shared mutation boundary for login, logout, refresh and rejection writes.
 * Low-level credential primitives are synchronous and must not reacquire this
 * lock. Keep interactive/network login work outside it; persist only at the end.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  clearServerCredentials,
  getCredentialLockPath,
  normalizeOrigin,
  type OAuthTokenSet,
  storeTokens,
} from "./credentials.ts";

/** Persist an explicit login (which intentionally selects the default server). */
export async function persistLoginTokens(
  server: string,
  tokens: OAuthTokenSet,
): Promise<void> {
  await mutateCredentials(server, () => storeTokens(server, tokens));
}

/** Explicit logout always clears the latest stored login, under the same lock. */
export async function logoutCredentials(server: string): Promise<void> {
  await mutateCredentials(server, () => clearServerCredentials(server));
}

async function mutateCredentials(
  server: string,
  action: () => void,
): Promise<void> {
  const result = await withRefreshLock(server, async () => action());
  if (result === LOCK_TIMEOUT)
    throw new Error("Credential store is busy. Try again.");
}

// =============================================================================
// Cross-process credential lock — serializes login persistence, explicit logout,
// refresh and rejection writes for one store + origin. Never acquire it twice.
// =============================================================================

/** Sentinel: the lock could not be acquired within the deadline. */
export const LOCK_TIMEOUT = Symbol("refresh-lock-timeout");

/** Reclaim a lock older than this with no heartbeat — its holder likely crashed. */
const LOCK_STALE_MS = 30_000;
/** Give up acquiring the lock after this long. Deliberately >= LOCK_STALE_MS so
 * a waiter always reaches the stale
 * threshold before giving up: a live holder either releases (we acquire) or
 * keeps its heartbeat fresh; we never fall through to an unlocked refresh. */
const LOCK_ACQUIRE_TIMEOUT_MS = 45_000;
/** Poll interval while waiting for a held lock. */
const LOCK_POLL_MS = 25;
/** Keep a live lock's mtime fresh while the network request is in flight. */
const LOCK_HEARTBEAT_MS = 5_000;

/** @internal Optional overrides for {@link withRefreshLock}; test-only knobs. */
export interface LockOptions {
  acquireTimeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @internal Exported for tests.
 * A filesystem-safe, per-origin lock name (origins contain `://` and `/`).
 */
export function lockPath(server: string, createDirectory = true): string {
  const key = createHash("sha256")
    .update(normalizeOrigin(server))
    .digest("hex")
    .slice(0, 16);
  return getCredentialLockPath(`refresh.${key}.lock`, createDirectory);
}

/** @internal Exported for tests. Serializes `action` on the per-server lock. */
export async function withRefreshLock<T>(
  server: string,
  action: () => Promise<T>,
  options?: LockOptions,
): Promise<T | typeof LOCK_TIMEOUT> {
  const acquireTimeoutMs = options?.acquireTimeoutMs ?? LOCK_ACQUIRE_TIMEOUT_MS;
  const staleMs = options?.staleMs ?? LOCK_STALE_MS;
  const pollMs = options?.pollMs ?? LOCK_POLL_MS;
  const heartbeatMs = options?.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  const lock = lockPath(server);
  const deadline = Date.now() + acquireTimeoutMs;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 }); // atomic create — EEXIST means held
      const owner = randomUUID();
      try {
        writeFileSync(join(lock, "owner"), owner, { flag: "wx", mode: 0o600 });
      } catch (error) {
        // The directory is ours and empty until this write. Clean it up rather
        // than stranding a lock when the marker write itself fails.
        try {
          rmdirSync(lock);
        } catch {
          // Best effort; report the original marker-write failure below.
        }
        throw error;
      }
      return await runWithRefreshLock(lock, owner, heartbeatMs, action);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Held by someone else. Check its age to reclaim a crashed holder's lock.
      let mtimeMs: number | undefined;
      try {
        mtimeMs = statSync(lock).mtimeMs;
      } catch (statError) {
        // Vanished between mkdir and stat → retry immediately; any other stat
        // error falls through to the bounded wait (never a tight spin).
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      if (mtimeMs !== undefined && Date.now() - mtimeMs > staleMs) {
        try {
          // Atomically move the old directory away before deleting it. A live
          // owner only releases a lock whose owner marker still matches, so it
          // can never remove the successor's directory after this handoff.
          const stalePath = `${lock}.${randomUUID()}.stale`;
          renameSync(lock, stalePath);
          rmSync(stalePath, { recursive: true, force: true });
        } catch {
          // Raced with another reclaimer; retry.
        }
        continue;
      }
      if (Date.now() >= deadline) return LOCK_TIMEOUT;
      await sleep(pollMs);
    }
  }
}

async function runWithRefreshLock<T>(
  lock: string,
  owner: string,
  heartbeatMs: number,
  action: () => Promise<T>,
): Promise<T> {
  // A refresh is normally short, but keep the mtime alive while awaiting a slow
  // network/keychain operation so stale recovery means a crashed (not merely
  // slow) owner. Verify ownership before touching the directory after a stale
  // handoff.
  const heartbeat = setInterval(() => {
    try {
      if (readFileSync(join(lock, "owner"), "utf-8") === owner) {
        const now = new Date();
        utimesSync(lock, now, now);
      }
    } catch {
      // Ownership was reclaimed or the lock is gone; the action's result is
      // still handled normally, but we must not mutate a successor's lock.
    }
  }, heartbeatMs);
  try {
    return await action();
  } finally {
    clearInterval(heartbeat);
    try {
      const ownerPath = join(lock, "owner");
      if (readFileSync(ownerPath, "utf-8") === owner) {
        unlinkSync(ownerPath);
        rmdirSync(lock);
      }
    } catch {
      // A reclaimer may already own the path; never remove its lock.
    }
  }
}
