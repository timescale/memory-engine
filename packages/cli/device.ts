/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) for `me login --device` — the
 * headless login path for sandboxes with no local browser. The CLI requests a
 * device + user code, shows the user a verification URL + code to open on any
 * device, and polls until they approve (or deny / it expires).
 *
 * This targets better-auth's `device-authorization` plugin endpoints, which are
 * NOT the standard OAuth token endpoint — they live under the auth base path as
 * `/device/code` and `/device/token`. (That's why this uses plain `fetch`
 * rather than `openid-client`, whose device helpers assume the single standard
 * `token_endpoint`.) On approval the plugin mints a better-auth SESSION, so the
 * response carries an `access_token` (a signed session bearer) but NO refresh token —
 * the stored token set simply omits it (see `session.ts`, which treats a missing
 * refresh token as "re-login when it lapses"; the session slides server-side on
 * use in the meantime). The server returns the signed session bearer form, not
 * the raw session-table token.
 */
import { OAUTH_CLIENT_ID, OAuthError, type OAuthTokens } from "./oauth.ts";

/** Auth base path (better-auth mounts the device endpoints here). */
const AUTH_BASE = "/api/v1/auth";

/** RFC 8628 device-code grant type used at the token endpoint. */
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** Fallbacks if the server omits them (it shouldn't). */
const DEFAULT_EXPIRES_IN_SECONDS = 900;
const DEFAULT_INTERVAL_SECONDS = 5;
/** RFC 8628 §3.5: bump the poll interval by 5s on a `slow_down`. */
const SLOW_DOWN_INCREMENT_MS = 5_000;

function deviceTimeoutError(): OAuthError {
  return new OAuthError(
    "Device login timed out before it was approved. Run 'me login --device' again.",
  );
}

function remainingMs(deadline: number): number {
  return deadline - Date.now();
}

async function sleepBeforeRetry(
  sleep: (ms: number) => Promise<void>,
  intervalMs: number,
  deadline: number,
): Promise<void> {
  // Stop before oversleeping past the code's expiry.
  if (Date.now() + intervalMs >= deadline) {
    throw deviceTimeoutError();
  }
  await sleep(intervalMs);
}

export interface DeviceAuthorization {
  /** The CLI's polling secret (kept local, sent to the token endpoint). */
  deviceCode: string;
  /** The short code the human enters in the browser. */
  userCode: string;
  /** Where the human goes to enter the code. */
  verificationUri: string;
  /** Same URL with the code pre-filled (`?user_code=…`), when provided. */
  verificationUriComplete?: string;
  /** Device/user code lifetime, seconds. */
  expiresIn: number;
  /** Minimum seconds between polls. */
  interval: number;
}

function base(server: string): string {
  return `${server.replace(/\/+$/, "")}${AUTH_BASE}`;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function errText(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.error_description === "string") return body.error_description;
  if (typeof body.error === "string") return body.error;
  return fallback;
}

/**
 * Request a device + user code (RFC 8628 §3.1–3.2). Restricted server-side to
 * the `me-cli` client.
 */
export async function startDeviceAuthorization(p: {
  server: string;
}): Promise<DeviceAuthorization> {
  let res: Response;
  try {
    res = await fetch(`${base(p.server)}/device/code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ client_id: OAUTH_CLIENT_ID }),
    });
  } catch (error) {
    throw new OAuthError(
      `Could not reach ${p.server} to start device login: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const body = await readJson(res);
  if (!res.ok) {
    throw new OAuthError(
      errText(
        body,
        `Device authorization request failed (${res.status}). The server may not support device login — upgrade it, or use 'me login'.`,
      ),
    );
  }
  const deviceCode = body.device_code;
  const userCode = body.user_code;
  const verificationUri = body.verification_uri;
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string"
  ) {
    throw new OAuthError(
      "The server returned an incomplete device authorization response.",
    );
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete:
      typeof body.verification_uri_complete === "string"
        ? body.verification_uri_complete
        : undefined,
    expiresIn:
      typeof body.expires_in === "number"
        ? body.expires_in
        : DEFAULT_EXPIRES_IN_SECONDS,
    interval:
      typeof body.interval === "number"
        ? body.interval
        : DEFAULT_INTERVAL_SECONDS,
  };
}

/**
 * Poll the token endpoint until the user approves (RFC 8628 §3.4–3.5). Handles
 * `authorization_pending` (keep waiting) and `slow_down` (back off); throws on
 * `access_denied`, `expired_token`, timeout, or any other error. On success
 * returns the signed session bearer as an {@link OAuthTokens} with no refresh
 * token.
 *
 * `sleep` is injectable for tests (defaults to real time).
 */
export async function pollDeviceToken(p: {
  server: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<OAuthTokens> {
  const sleep = p.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = Date.now() + p.expiresIn * 1000;
  let intervalMs = Math.max(1, p.interval) * 1000;

  while (true) {
    let res: Response;
    const requestTimeoutMs = remainingMs(deadline);
    if (requestTimeoutMs <= 0) {
      throw deviceTimeoutError();
    }
    try {
      res = await fetch(`${base(p.server)}/device/token`, {
        method: "POST",
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: p.deviceCode,
          client_id: OAUTH_CLIENT_ID,
        }),
      });
    } catch {
      // RFC 8628 §3.5: retry connection failures, but reduce polling frequency.
      // A per-request AbortSignal bounds hung connections by the device-code TTL;
      // other rejected fetches (e.g. transient network failures) follow the same
      // backoff path.
      intervalMs += SLOW_DOWN_INCREMENT_MS;
      await sleepBeforeRetry(sleep, intervalMs, deadline);
      continue;
    }
    const body = await readJson(res);

    if (res.ok) {
      if (typeof body.access_token !== "string") {
        throw new OAuthError(
          "The server approved the device but returned no access token.",
        );
      }
      return {
        accessToken: body.access_token,
        // Device flow mints a session, not an OAuth token pair — no refresh token.
        // The server rewrites this to the signed session bearer form.
        refreshToken: undefined,
        expiresIn:
          typeof body.expires_in === "number" ? body.expires_in : undefined,
        scope: typeof body.scope === "string" ? body.scope : undefined,
      };
    }

    switch (body.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        intervalMs += SLOW_DOWN_INCREMENT_MS;
        break;
      case "access_denied":
        throw new OAuthError("Device login was denied in the browser.");
      case "expired_token":
        throw new OAuthError(
          "The device code expired before it was approved. Run 'me login --device' again.",
        );
      default:
        throw new OAuthError(
          errText(body, `Device token request failed (${res.status}).`),
        );
    }

    await sleepBeforeRetry(sleep, intervalMs, deadline);
  }
}
