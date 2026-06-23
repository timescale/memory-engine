/**
 * JSON-RPC 2.0 transport layer.
 *
 * Handles HTTP communication, retry logic with exponential backoff,
 * timeouts, and JSON-RPC envelope formatting.
 */
import { CLIENT_VERSION_HEADER } from "@memory.build/protocol/headers";
import type {
  JsonRpcErrorResponse,
  JsonRpcResponse,
} from "@memory.build/protocol/jsonrpc";
import { RpcError } from "./errors.ts";

// =============================================================================
// Types
// =============================================================================

/**
 * Transport configuration.
 */
export interface TransportConfig {
  /** Base URL of the Memory Engine server */
  url: string;
  /** RPC endpoint path (appended to url) */
  path: string;
  /** Static bearer token for authentication. Ignored when `getToken` is set. */
  token?: string;
  /**
   * Async bearer provider, resolved once per `rpcCall` (before the first
   * attempt). Overrides `token`. This is the proactive refresh seam: a provider
   * returns a still-valid access token, refreshing it by expiry when stale.
   */
  getToken?: () => Promise<string | undefined>;
  /**
   * Reactive refresh seam: invoked once when a request comes back 401, to force
   * a token refresh. Returns a fresh bearer to retry with, or undefined to give
   * up (the 401 then surfaces as an error). Fires before the 401 is turned into
   * an RpcError, and the retry does not consume the normal retry budget.
   */
  onUnauthorized?: () => Promise<string | undefined>;
  /** Request timeout in milliseconds (default: 30000) */
  timeout: number;
  /** Default maximum retry attempts (default: 3). Can be overridden per call. */
  retries: number;
  /**
   * Caller's CLIENT_VERSION. When set, sent on every RPC as the
   * `X-Client-Version` header so the server can reject too-old clients
   * before dispatch. Optional — older callers without this set still work.
   */
  clientVersion?: string;
  /**
   * Extra headers sent on every RPC (e.g. `X-Me-Space` to select the space for
   * the memory endpoint). Merged after the built-in headers.
   */
  headers?: Record<string, string>;
}

export interface RpcCallOptions {
  /** Override the configured retry budget for this call. */
  retries?: number;
}

// =============================================================================
// Constants
// =============================================================================

/** HTTP status codes that trigger a retry. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Maximum backoff delay in milliseconds. */
const MAX_BACKOFF_MS = 30_000;

/** Base backoff delay in milliseconds. */
const BASE_BACKOFF_MS = 500;

// =============================================================================
// Transport
// =============================================================================

/** Auto-incrementing request ID counter. */
let nextId = 1;

/**
 * Make a JSON-RPC 2.0 call over HTTP.
 *
 * Handles:
 * - JSON-RPC 2.0 envelope formatting
 * - Bearer token authentication
 * - Request timeouts via AbortController
 * - Automatic retries with exponential backoff + jitter
 * - Retry-After header support
 *
 * @throws {RpcError} When the server returns a JSON-RPC error
 * @throws {Error} For network failures after all retries exhausted
 */
export async function rpcCall<TResult>(
  config: TransportConfig,
  method: string,
  params: unknown,
  options: RpcCallOptions = {},
): Promise<TResult> {
  const retries = options.retries ?? config.retries;
  const id = nextId++;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
    id,
  });

  const endpoint = `${config.url}${config.path}`;
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (config.clientVersion) {
    baseHeaders[CLIENT_VERSION_HEADER] = config.clientVersion;
  }
  if (config.headers) {
    Object.assign(baseHeaders, config.headers);
  }

  // Proactive token resolution: a provider (when set) returns a still-valid
  // access token, refreshing by expiry. Resolved once — 5xx/network retries
  // reuse it; only a 401 triggers a re-resolve via onUnauthorized.
  let bearer = config.getToken ? await config.getToken() : config.token;
  let authRetried = false;

  let lastError: Error | undefined;
  let attempt = 0;

  while (true) {
    // Backoff before retries (not the first attempt)
    if (attempt > 0) {
      const delay = backoff(attempt, lastError);
      await sleep(delay);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout);

    try {
      const headers = { ...baseHeaders };
      if (bearer) headers.Authorization = `Bearer ${bearer}`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // Reactive refresh: a 401 gets one shot at a fresh token before it
      // becomes an error. This retry is free — it doesn't advance `attempt`,
      // so it neither consumes the retry budget nor incurs backoff.
      if (response.status === 401 && config.onUnauthorized && !authRetried) {
        authRetried = true;
        const fresh = await config.onUnauthorized();
        if (fresh && fresh !== bearer) {
          bearer = fresh;
          continue;
        }
      }

      // Retryable HTTP status — retry if attempts remain
      if (RETRYABLE_STATUSES.has(response.status) && attempt < retries) {
        lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
        // Respect Retry-After header if present
        const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
        if (retryAfter !== undefined) {
          await sleep(retryAfter);
        }
        attempt++;
        continue;
      }

      // Parse JSON-RPC response. Some proxies preserve non-2xx upstream
      // statuses while still returning a JSON-RPC error envelope, so parse
      // before throwing generic HTTP errors.
      let rpcResponse: JsonRpcResponse;
      try {
        rpcResponse = (await response.json()) as JsonRpcResponse;
      } catch (error) {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        throw error instanceof Error ? error : new Error(String(error));
      }

      // JSON-RPC error
      if ("error" in rpcResponse) {
        const { error } = rpcResponse as JsonRpcErrorResponse;
        throw new RpcError(
          error.code,
          error.message,
          error.data as { code: string; [key: string]: unknown } | undefined,
        );
      }

      // Non-retryable HTTP error without a JSON-RPC error envelope.
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      // Success
      return rpcResponse.result as TResult;
    } catch (error) {
      clearTimeout(timeout);

      // Don't retry RpcErrors — they are definitive server responses
      if (error instanceof RpcError) {
        throw error;
      }

      // Don't retry non-retryable HTTP errors
      if (
        error instanceof Error &&
        error.message.startsWith("HTTP ") &&
        !RETRYABLE_STATUSES.has(
          Number.parseInt(error.message.split(" ")[1] ?? "0", 10),
        )
      ) {
        throw error;
      }

      // Retryable: timeouts and network failures
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt >= retries) {
        throw lastError;
      }
      attempt++;
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Calculate backoff delay with jitter.
 */
function backoff(attempt: number, _lastError?: Error): number {
  const exponential = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  const jitter = Math.random() * BASE_BACKOFF_MS;
  return Math.min(exponential + jitter, MAX_BACKOFF_MS);
}

/**
 * Parse Retry-After header value.
 * Supports both delay-seconds and HTTP-date formats.
 * Returns milliseconds or undefined if not parseable.
 */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;

  // Try as seconds
  const seconds = Number.parseInt(value, 10);
  if (!Number.isNaN(seconds)) {
    return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  }

  // Try as HTTP date
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    const delay = date.getTime() - Date.now();
    return Math.min(Math.max(delay, 0), MAX_BACKOFF_MS);
  }

  return undefined;
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
