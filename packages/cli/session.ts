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
 *     store. Login persistence and explicit logout take this same lock. Inside
 *     the lock we RE-READ the stored token, so a process that was
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
import { RpcError } from "./client.ts";
import {
  LOCK_TIMEOUT,
  lockPath,
  withRefreshLock,
} from "./credential-mutation.ts";

export {
  LOCK_TIMEOUT,
  type LockOptions,
  lockPath,
  withRefreshLock,
} from "./credential-mutation.ts";

import {
  getStoredTokens,
  type OAuthTokenSet,
  storeTokens,
} from "./credentials.ts";
import { OAuthError, refreshTokens } from "./oauth.ts";

/** Refresh once the access token is within this window of expiring. */
const REFRESH_SKEW_MS = 60_000;

/**
 * Safe for CLI/MCP rendering; RpcError makes the transport treat a reactive
 * rejection as definitive rather than retrying it as a network failure.
 */
export class ReLoginRequiredError extends RpcError {
  constructor() {
    super(
      -32000,
      "Login expired or revoked. Run 'me login' to sign in again.",
      {
        code: "UNAUTHORIZED",
      },
    );
    this.name = "ReLoginRequiredError";
  }
}

// Durable tombstones are the cross-process authority. This bounded, hash-only
// fallback prevents a long-running client replaying a rejection if disk/keychain
// persistence fails. Scope by credential store as well as normalized origin.
const localRejections = new Map<string, string>();
const MAX_LOCAL_REJECTIONS = 64;
// Scope calculation must not write to a credential store that may be failing.
const rejectionScope = (server: string) => lockPath(server, false);
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

function rememberRejected(server: string, token: string): void {
  const scope = rejectionScope(server);
  localRejections.delete(scope);
  localRejections.set(scope, tokenHash(token));
  if (localRejections.size > MAX_LOCAL_REJECTIONS) {
    const oldest = localRejections.keys().next().value;
    if (oldest !== undefined) localRejections.delete(oldest);
  }
}

function assertNotRejected(
  tokens: OAuthTokenSet | undefined,
  server: string,
): void {
  if (tokens?.refresh_rejected) throw new ReLoginRequiredError();
  if (tokens?.refresh_token && localRejections.size > 0) {
    const rejected = localRejections.get(rejectionScope(server));
    if (rejected && rejected === tokenHash(tokens.refresh_token))
      throw new ReLoginRequiredError();
  }
}

/**
 * A live access token for `server`, refreshing by expiry. Returns undefined when
 * the user is not logged in (no stored token set and no override). On a failed
 * transient refresh it falls back to the current (possibly still-valid) access
 * token — the reactive 401 path is the backstop. A definite invalid_grant is
 * terminal and throws an actionable re-login error instead.
 */
export async function getAccessToken(
  server: string,
): Promise<string | undefined> {
  const override = process.env.ME_SESSION_TOKEN;
  if (override) return override;

  const tokens = getStoredTokens(server);
  if (!tokens) return undefined;
  assertNotRejected(tokens, server);
  if (!isExpiring(tokens)) return tokens.access_token;

  const refreshed = await refreshOnce(server, tokens);
  // Re-read on transient failure too: logout/rejection must not revive our
  // stale snapshot, and a peer's newer credentials must win.
  const usable = refreshed ?? getStoredTokens(server);
  assertNotRejected(usable, server);
  return usable?.access_token;
}

/**
 * Force a refresh after a 401 and return the new access token. Returns undefined
 * when there is nothing to refresh with (an injected ME_SESSION_TOKEN, no stored
 * refresh token, or a transient refresh failure). Definite/persisted rejection
 * throws ReLoginRequiredError instead of retrying the rejected credential.
 */
export async function refreshAccessToken(
  server: string,
): Promise<string | undefined> {
  if (process.env.ME_SESSION_TOKEN) return undefined; // injected token: can't refresh
  const tokens = getStoredTokens(server);
  assertNotRejected(tokens, server);
  if (!tokens?.refresh_token) return undefined;
  const refreshed = await refreshOnce(server, tokens);
  return refreshed?.access_token;
}

function isExpiring(t: OAuthTokenSet): boolean {
  // Unknown expiry → trust the token; the reactive 401 path covers staleness.
  if (t.expires_at === undefined) return false;
  return Date.now() + REFRESH_SKEW_MS >= t.expires_at;
}

/** In-flight refresh per credential store + server origin.
 * Keyed on the same lock identity (including NORMALIZED origin) so `https://api.example.com` and
 * `https://api.example.com/` collapse to one entry (otherwise callers with the
 * same server-but-different-string would each pay the file-lock round-trip). */
const inFlight = new Map<string, Promise<OAuthTokenSet | undefined>>();

/**
 * Run (or join) a single refresh for `server`, persisting the rotated token set.
 * Returns undefined when there is no refresh token or a transient exchange
 * failure. A persisted/definite invalid_grant throws ReLoginRequiredError.
 *
 * The in-process `inFlight` map is the fast path (same-process concurrency never
 * touches the file lock); {@link lockedRefresh} handles the cross-process case.
 */
function refreshOnce(
  server: string,
  tokens: OAuthTokenSet,
): Promise<OAuthTokenSet | undefined> {
  if (!tokens.refresh_token) return Promise.resolve(undefined);

  const key = rejectionScope(server);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = lockedRefresh(server, tokens).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}

/**
 * Serialize the refresh across processes: acquire the per-server lock, then
 * RE-READ the stored token. If a peer already rotated it while we waited, the
 * stored access token is now fresh and we return it without a round-trip — the
 * key that stops a waiting process from replaying the now-revoked refresh token.
 * Only if the token is still expiring do we actually refresh, under the lock.
 *
 * If the lock can't be acquired in time we re-read once for a peer's completed
 * rotation, then give up. Never refresh unlocked: doing so reopens precisely the
 * concurrent replay race the lock exists to prevent.
 */
async function lockedRefresh(
  server: string,
  tokens: OAuthTokenSet,
): Promise<OAuthTokenSet | undefined> {
  const locked = await withRefreshLock(server, () =>
    refreshFromStore(server, tokens),
  );
  if (locked !== LOCK_TIMEOUT) return locked;

  // A peer may have finished immediately after our final acquire attempt. Use
  // its rotated set if present, but never send our stale refresh token unlocked.
  const current = getStoredTokens(server);
  assertNotRejected(current, server);
  if (current?.refresh_token !== tokens.refresh_token) return current;
  return undefined;
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
  // An absent store means logout/clear, not permission to resurrect fallback.
  const current = getStoredTokens(server);
  if (!current) return undefined;
  assertNotRejected(current, server);
  if (
    current.refresh_token &&
    current.refresh_token !== fallback.refresh_token
  ) {
    // Our fallback.refresh_token has been superseded by peer's rotation, so it
    // is now revoked — never replay it. If peer's access token is still fresh,
    // return it and skip the network. If peer's rotation was long enough ago
    // that its access token is now expiring, refresh with PEER's refresh_token
    // (the current, valid one), not ours. Mirrors the invalid_grant catch below.
    if (!isExpiring(current)) return current;
    return doRefresh(server, current.refresh_token, current);
  }
  const refreshToken = current.refresh_token;
  if (!refreshToken) {
    // A device/access-only login may have completed while we waited. It has no
    // refresh token to exchange, but its changed, fresh bearer is usable.
    return current.access_token !== fallback.access_token &&
      !isExpiring(current)
      ? current
      : undefined;
  }
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
    // All production mutations share this lock. Also defend against a missing
    // keychain read or a writer from an older CLI that does not take the lock.
    const current = getStoredTokens(server);
    assertNotRejected(current, server);
    if (!current || current.refresh_token !== refreshToken) return current;
    storeTokens(server, next, { setDefault: false });
    return next;
  } catch (error) {
    // A genuinely dead refresh token (`invalid_grant`) can be the losing side of
    // a rotation race or a lost response from a prior successful refresh. Before
    // giving up, re-read the store once: a concurrent/previous refresh may have
    // already persisted a fresh set we can use instead of forcing a re-login.
    if (error instanceof OAuthError && error.code === "invalid_grant") {
      // Even an empty reread can be a temporary keychain failure, not logout.
      // Record every definite rejection locally before attempting recovery.
      rememberRejected(server, refreshToken);
      const current = getStoredTokens(server);
      // The matching token is now locally rejected; inspect peers/tombstones
      // without applying that just-recorded guard to our own token.
      if (current?.refresh_rejected) throw new ReLoginRequiredError();
      if (current?.refresh_token !== refreshToken) {
        assertNotRejected(current, server);
        if (current && !isExpiring(current)) return current;
        // A peer's newer access token may itself have expired while we waited;
        // its refresh token is still the only safe one to use. Never replay the
        // rejected token that triggered this invalid_grant.
        if (current?.refresh_token) {
          return doRefresh(server, current.refresh_token, current);
        }
      } else if (current) {
        // Still our rejected token. Persist one bounded, nonsecret tombstone in
        // the existing credential record, under the same refresh lock. Dropping
        // the raw refresh token prevents any subsequent layer/process replay.
        const { refresh_token: _rejected, ...rest } = current;
        try {
          storeTokens(
            server,
            { ...rest, refresh_rejected: tokenHash(refreshToken) },
            { setDefault: false },
          );
        } catch {
          // Credential writes can fail before or after persistence. Neither
          // turns invalid_grant into a retryable transport error; the local
          // guard remains in both cases.
        }
      }
      throw new ReLoginRequiredError();
    }
    if (error instanceof ReLoginRequiredError) throw error;
    // Network/protocol failures other than definite invalid_grant are retryable.
    return undefined;
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
