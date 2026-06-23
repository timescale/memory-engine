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
 * are deduped per server so concurrent callers (the long-running `me mcp` /
 * `me serve` processes) don't race the rotating refresh token, and the rotated
 * token set is persisted on every refresh.
 *
 * `ME_SESSION_TOKEN` is a raw bearer override (CI / scripting): it is returned
 * as-is and never refreshed.
 *
 * Agents do not use this module — they present a static `ME_API_KEY`; see
 * {@link memoryBearer}.
 */
import {
  getStoredTokens,
  type OAuthTokenSet,
  storeTokens,
} from "./credentials.ts";
import { refreshTokens } from "./oauth.ts";

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
 */
function refreshOnce(
  server: string,
  tokens: OAuthTokenSet,
): Promise<OAuthTokenSet | undefined> {
  if (!tokens.refresh_token) return Promise.resolve(undefined);

  const existing = inFlight.get(server);
  if (existing) return existing;

  const run = doRefresh(server, tokens.refresh_token, tokens).finally(() => {
    inFlight.delete(server);
  });
  inFlight.set(server, run);
  return run;
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
  } catch {
    // Expired / revoked refresh token (or transient failure) → give up; the
    // caller surfaces the auth error and the user re-runs `me login`.
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
 * Bearer source for the user endpoint (/api/v1/user/rpc) — session/OAuth only,
 * never an api key (agents can't manage agents).
 */
export function userBearer(server: string): BearerSource {
  return {
    getToken: () => getAccessToken(server),
    onUnauthorized: () => refreshAccessToken(server),
  };
}

/**
 * Bearer source for the memory endpoint (/api/v1/memory/rpc), which accepts
 * either bearer. An agent api key (when present) is static — returned as-is and
 * never refreshed; otherwise the human OAuth access token with refresh.
 */
export function memoryBearer(server: string, apiKey?: string): BearerSource {
  if (apiKey) {
    return {
      getToken: async () => apiKey,
      onUnauthorized: async () => undefined,
    };
  }
  return userBearer(server);
}
