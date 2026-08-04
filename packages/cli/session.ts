/**
 * Human session lifecycle — turning a stored OAuth token set into a live bearer
 * for RPC clients, refreshing it as it ages.
 *
 * Best-practice CLI token handling is two-layered:
 *   - Proactive ({@link getAccessToken}): before each call, hand back the stored
 *     access token, but refresh it first when it is expired or within a small
 *     clock-skew buffer of expiring. Avoids a guaranteed-401 round-trip.
 *   - Reactive ({@link refreshAccessToken}): if a request comes back 401 anyway
 *     (clock skew, server-side early revocation), force one refresh and retry.
 *
 * These pair with the transport's `getToken` / `onUnauthorized` seams. Refreshes
 * are deduped two ways so a rotating refresh token is never replayed:
 *   - In-process: an `inFlight` map collapses concurrent callers in one process
 *     into a single round-trip.
 *   - Cross-process: a filesystem lock ({@link withRefreshLock}) serializes the
 *     read-refresh-persist across separate `me` processes on one host (CLI +
 *     `me mcp` / `me serve`, parallel invocations), which share one credential
 *     store. Inside the lock we RE-READ the stored token, so a process that was
 *     waiting sees the peer's freshly-rotated token and returns it instead of
 *     replaying the now-revoked one — which would otherwise trip the server's
 *     refresh-token reuse detection and invalidate the whole token family.
 * The rotated token set is persisted on every refresh.
 *
 * `ME_SESSION_TOKEN` is a raw bearer override (CI / scripting): it is returned
 * as-is and never refreshed.
 *
 */

import { createHash } from "node:crypto";
import { mkdirSync, rmdirSync, statSync } from "node:fs";
import {
  getConfigLockPath,
  getStoredTokens,
  normalizeOrigin,
  type OAuthTokenSet,
  storeTokens,
} from "./credentials.ts";
import { OAuthError, refreshTokens } from "./oauth.ts";

/** Refresh once the access token is within this window of expiring. */
const REFRESH_SKEW_MS = 60_000;

/**
 * A live access token for `server`, refreshing by expiry. Returns undefined when
 * the user is not logged in (no stored token set and no override). On a failed
 * refresh it falls back to the current (possibly still-valid) access token —
 * the reactive 401 path is the backstop.
 */
export async function getAccessToken(
  server: string,
): Promise<string | undefined> {
  const override = process.env.ME_SESSION_TOKEN;
  if (override) return override;

  const tokens = getStoredTokens(server);
  if (!tokens) return undefined;
  if (!isExpiring(tokens)) return tokens.access_token;

  const refreshed = await refreshOnce(server, tokens);
  return (refreshed ?? tokens).access_token;
}

/**
 * Force a refresh after a 401 and return the new access token. Returns undefined
 * when there is nothing to refresh with (an injected ME_SESSION_TOKEN, no stored
 * refresh token, or a refresh that failed) — the caller then surfaces the 401,
 * prompting a re-login.
 */
export async function refreshAccessToken(
  server: string,
): Promise<string | undefined> {
  if (process.env.ME_SESSION_TOKEN) return undefined; // injected token: can't refresh
  const tokens = getStoredTokens(server);
  if (!tokens?.refresh_token) return undefined;
  const refreshed = await refreshOnce(server, tokens);
  return refreshed?.access_token;
}

function isExpiring(t: OAuthTokenSet): boolean {
  // Unknown expiry → trust the token; the reactive 401 path covers staleness.
  if (t.expires_at === undefined) return false;
  return Date.now() + REFRESH_SKEW_MS >= t.expires_at;
}

/** In-flight refresh per server origin — concurrent callers share one round-trip. */
const inFlight = new Map<string, Promise<OAuthTokenSet | undefined>>();

/**
 * Run (or join) a single refresh for `server`, persisting the rotated token set.
 * Returns undefined when there is no refresh token or the exchange fails.
 *
 * The in-process `inFlight` map is the fast path (same-process concurrency never
 * touches the file lock); {@link lockedRefresh} handles the cross-process case.
 */
function refreshOnce(
  server: string,
  tokens: OAuthTokenSet,
): Promise<OAuthTokenSet | undefined> {
  if (!tokens.refresh_token) return Promise.resolve(undefined);

  const existing = inFlight.get(server);
  if (existing) return existing;

  const run = lockedRefresh(server, tokens).finally(() => {
    inFlight.delete(server);
  });
  inFlight.set(server, run);
  return run;
}

/**
 * Serialize the refresh across processes: acquire the per-server lock, then
 * RE-READ the stored token. If a peer already rotated it while we waited, the
 * stored access token is now fresh and we return it without a round-trip — the
 * key that stops a waiting process from replaying the now-revoked refresh token.
 * Only if the token is still expiring do we actually refresh, under the lock.
 *
 * If the lock can't be acquired in time we degrade rather than fail: re-read
 * once (a peer may have just refreshed) and otherwise fall back to an unlocked
 * refresh — i.e. exactly today's behavior, never worse.
 */
async function lockedRefresh(
  server: string,
  tokens: OAuthTokenSet,
): Promise<OAuthTokenSet | undefined> {
  const locked = await withRefreshLock(server, () =>
    refreshFromStore(server, tokens),
  );
  if (locked !== LOCK_TIMEOUT) return locked;

  // Degraded path: couldn't acquire the lock in time. refreshFromStore still
  // defers to a peer's rotation (no network) and otherwise refreshes unlocked —
  // exactly the pre-lock behavior, never worse.
  return refreshFromStore(server, tokens);
}

/**
 * @internal Exported for tests.
 *
 * Refresh using the freshest stored token. Re-reads the store first: if a peer
 * (under the same lock) already rotated the refresh token, the stored access
 * token is newer than ours, so return it instead of replaying our now-revoked
 * refresh token. Otherwise perform the exchange + persist. Keyed on refresh-token
 * identity rather than expiry so the reactive 401 path still forces a refresh of
 * a locally-fresh-but-server-rejected token.
 */
export async function refreshFromStore(
  server: string,
  fallback: OAuthTokenSet,
): Promise<OAuthTokenSet | undefined> {
  const current = getStoredTokens(server) ?? fallback;
  if (
    current.refresh_token &&
    current.refresh_token !== fallback.refresh_token
  ) {
    return current;
  }
  const refreshToken = current.refresh_token ?? fallback.refresh_token;
  if (!refreshToken) return undefined;
  return doRefresh(server, refreshToken, current);
}

async function doRefresh(
  server: string,
  refreshToken: string,
  prev: OAuthTokenSet,
): Promise<OAuthTokenSet | undefined> {
  try {
    const r = await refreshTokens({ server, refreshToken });
    const next: OAuthTokenSet = {
      access_token: r.accessToken,
      // Refresh-token rotation: persist the new one when returned, else reuse.
      refresh_token: r.refreshToken ?? prev.refresh_token,
      expires_at:
        r.expiresIn !== undefined ? Date.now() + r.expiresIn * 1000 : undefined,
      scope: r.scope ?? prev.scope,
    };
    storeTokens(server, next);
    return next;
  } catch (error) {
    // A genuinely dead refresh token (`invalid_grant`) can be the losing side of
    // a rotation race or a lost response from a prior successful refresh. Before
    // giving up, re-read the store once: a concurrent/previous refresh may have
    // already persisted a fresh set we can use instead of forcing a re-login.
    if (error instanceof OAuthError && error.code === "invalid_grant") {
      const current = getStoredTokens(server);
      if (
        current &&
        current.refresh_token !== refreshToken &&
        !isExpiring(current)
      ) {
        return current;
      }
    }
    // Expired / revoked refresh token (or transient failure) → give up; the
    // caller surfaces the auth error and the user re-runs `me login`.
    return undefined;
  }
}

// =============================================================================
// Cross-process refresh lock — a directory used as a filesystem mutex, keyed by
// server origin, so separate `me` processes serialize their token refreshes.
// =============================================================================

/** Sentinel: the lock could not be acquired within the deadline. */
export const LOCK_TIMEOUT = Symbol("refresh-lock-timeout");

/** Give up acquiring the lock after this long and degrade to an unlocked refresh. */
const LOCK_ACQUIRE_TIMEOUT_MS = 15_000;
/** Reclaim a lock older than this — its holder must have crashed. Exceeds the
 * worst-case refresh round-trip so a live holder is never stolen from. */
const LOCK_STALE_MS = 30_000;
/** Poll interval while waiting for a held lock. */
const LOCK_POLL_MS = 25;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @internal Exported for tests.
 * A filesystem-safe, per-origin lock name (origins contain `://` and `/`).
 */
export function lockPath(server: string): string {
  const key = createHash("sha256")
    .update(normalizeOrigin(server))
    .digest("hex")
    .slice(0, 16);
  return getConfigLockPath(`refresh.${key}.lock`);
}

/** @internal Exported for tests. Serializes `action` on the per-server lock. */
export async function withRefreshLock<T>(
  server: string,
  action: () => Promise<T>,
): Promise<T | typeof LOCK_TIMEOUT> {
  const lock = lockPath(server);
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lock); // atomic create — EEXIST means someone else holds it
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
      if (mtimeMs !== undefined && Date.now() - mtimeMs > LOCK_STALE_MS) {
        try {
          rmdirSync(lock);
        } catch {
          // Raced with another reclaimer; retry.
        }
        continue;
      }
      if (Date.now() >= deadline) return LOCK_TIMEOUT;
      await sleep(LOCK_POLL_MS);
      continue;
    }
    try {
      return await action();
    } finally {
      try {
        rmdirSync(lock);
      } catch {
        // Best effort: a reclaimer may have already removed it.
      }
    }
  }
}

// =============================================================================
// Bearer sources — wire credentials into the client transport's refresh seams.
// =============================================================================

/** A bearer provider + reactive-refresh hook for a client transport. */
export interface BearerSource {
  /** Proactive: a fresh bearer for each call (transport `getToken`). */
  getToken: () => Promise<string | undefined>;
  /** Reactive: force a refresh after a 401 (transport `onUnauthorized`). */
  onUnauthorized: () => Promise<string | undefined>;
}

/**
 * Bearer source for the user endpoint (/api/v1/user/rpc). Both endpoints accept
 * either bearer: a static API key is returned as-is and never refreshed;
 * otherwise the human OAuth access token with refresh.
 */
export function userBearer(server: string, apiKey?: string): BearerSource {
  if (apiKey) {
    return {
      getToken: async () => apiKey,
      onUnauthorized: async () => undefined,
    };
  }
  return {
    getToken: () => getAccessToken(server),
    onUnauthorized: () => refreshAccessToken(server),
  };
}

/**
 * Bearer source for the memory endpoint (/api/v1/memory/rpc) — identical policy
 * to {@link userBearer}: a static api key (when present) else the refreshed
 * human OAuth token.
 */
export function memoryBearer(server: string, apiKey?: string): BearerSource {
  return userBearer(server, apiKey);
}
