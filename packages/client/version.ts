/**
 * Client/server version compatibility check.
 *
 * Calls the unauthenticated `GET /api/v1/version` endpoint and verifies
 * compatibility in both directions:
 *
 *   1. Server-side: server reports `minClientVersion`. If our `clientVersion`
 *      is below that bound, the server flags `client.compatible: false`.
 *   2. Client-side: caller passes `minServerVersion`. We compare the
 *      reported `serverVersion` against it locally.
 *
 * On any incompatibility, throws an `RpcError` with a typed `appCode`
 * (`CLIENT_VERSION_INCOMPATIBLE` or `SERVER_VERSION_INCOMPATIBLE`) so the
 * CLI can render an upgrade message.
 *
 * @example
 * ```ts
 * import { checkServerVersion } from "@memory.build/client";
 *
 * await checkServerVersion({
 *   url: "https://api.memory.build",
 *   clientVersion: CLIENT_VERSION,
 *   minServerVersion: MIN_SERVER_VERSION,
 * });
 * ```
 */
import {
  APP_ERROR_CODES,
  RPC_ERROR_CODES,
  type VersionResponse,
} from "@memory.build/protocol";
import { RpcError } from "./errors.ts";

// =============================================================================
// Options
// =============================================================================

/**
 * Options for `checkServerVersion`.
 */
export interface CheckServerVersionOptions {
  /** Base URL of the Memory Engine server. */
  url: string;
  /** Caller's CLIENT_VERSION. Sent as `?clientVersion=` in the query string. */
  clientVersion: string;
  /**
   * Oldest SERVER_VERSION the caller will accept. Compared locally against the
   * `serverVersion` returned by the endpoint.
   */
  minServerVersion: string;
  /** Path to the version endpoint (default: "/api/v1/version"). */
  path?: string;
  /** Request timeout in milliseconds (default: 10000). */
  timeout?: number;
}

// =============================================================================
// Public API
// =============================================================================

const DEFAULT_PATH = "/api/v1/version";
const DEFAULT_TIMEOUT = 10_000;

/**
 * Verify the configured server is compatible with this client.
 *
 * Returns the parsed `VersionResponse` on success.
 *
 * @throws {RpcError} `CLIENT_VERSION_INCOMPATIBLE` — this client is too old
 *                    for the server (server says we're below `minClientVersion`).
 * @throws {RpcError} `SERVER_VERSION_INCOMPATIBLE` — the server is too old for
 *                    this client (server's `serverVersion` is below the
 *                    caller's `minServerVersion`).
 * @throws {Error}    Network or parse failures.
 */
export async function checkServerVersion(
  options: CheckServerVersionOptions,
): Promise<VersionResponse> {
  const url = options.url.replace(/\/+$/, "");
  const path = options.path ?? DEFAULT_PATH;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  const endpoint = `${url}${path}?clientVersion=${encodeURIComponent(options.clientVersion)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(
      `Version check failed: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as VersionResponse;

  // Server flagged this client as incompatible.
  if (body.client && !body.client.compatible) {
    throw new RpcError(
      RPC_ERROR_CODES.APPLICATION_ERROR,
      `This CLI (v${options.clientVersion}) is too old for the server. ` +
        `Minimum supported client version is ${body.minClientVersion}. ` +
        `Please upgrade: https://memory.build/docs/getting-started`,
      {
        code: APP_ERROR_CODES.CLIENT_VERSION_INCOMPATIBLE,
        clientVersion: options.clientVersion,
        minClientVersion: body.minClientVersion,
        serverVersion: body.serverVersion,
      },
    );
  }

  // Local check: server is too old for this client.
  if (compareSemver(body.serverVersion, options.minServerVersion) < 0) {
    throw new RpcError(
      RPC_ERROR_CODES.APPLICATION_ERROR,
      `The server (v${body.serverVersion}) is too old for this CLI ` +
        `(v${options.clientVersion}). Minimum required server version is ` +
        `${options.minServerVersion}. The server needs to be upgraded.`,
      {
        code: APP_ERROR_CODES.SERVER_VERSION_INCOMPATIBLE,
        clientVersion: options.clientVersion,
        serverVersion: body.serverVersion,
        minServerVersion: options.minServerVersion,
      },
    );
  }

  return body;
}

// =============================================================================
// Internal: minimal semver comparison
// =============================================================================

/**
 * Compare two semver strings. Returns -1 / 0 / 1 like `Array.prototype.sort`.
 *
 * Intentionally minimal — handles the `MAJOR.MINOR.PATCH` form used by both
 * release tracks. Pre-release suffixes (`-rc.1`, `-beta`) are stripped before
 * numeric comparison; build metadata is ignored. We don't pull in a full
 * semver implementation to keep the published client small.
 *
 * Exported for testing only.
 *
 * @internal
 */
export function compareSemver(a: string, b: string): number {
  const partsA = parseVersion(a);
  const partsB = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const da = partsA[i] ?? 0;
    const db = partsB[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function parseVersion(v: string): number[] {
  // Strip pre-release / build metadata: keep only the leading MAJOR.MINOR.PATCH.
  const core = v.split(/[-+]/)[0] ?? v;
  return core.split(".").map((n) => {
    const parsed = Number.parseInt(n, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
}
