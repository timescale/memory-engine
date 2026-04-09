/**
 * JSON-RPC 2.0 transport layer.
 *
 * Handles HTTP communication, retry logic with exponential backoff,
 * timeouts, and JSON-RPC envelope formatting.
 */
import type {
  JsonRpcErrorResponse,
  JsonRpcResponse,
} from "@memory-engine/protocol/jsonrpc";
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
  /** Bearer token for authentication */
  token?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout: number;
  /** Maximum retry attempts (default: 3) */
  retries: number;
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
): Promise<TResult> {
  const id = nextId++;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
    id,
  });

  const endpoint = `${config.url}${config.path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= config.retries; attempt++) {
    // Backoff before retries (not the first attempt)
    if (attempt > 0) {
      const delay = backoff(attempt, lastError);
      await sleep(delay);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // Retryable HTTP status — retry if attempts remain
      if (RETRYABLE_STATUSES.has(response.status) && attempt < config.retries) {
        lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
        // Respect Retry-After header if present
        const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
        if (retryAfter !== undefined) {
          await sleep(retryAfter);
        }
        continue;
      }

      // Non-retryable HTTP error
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      // Parse JSON-RPC response
      const rpcResponse = (await response.json()) as JsonRpcResponse;

      // JSON-RPC error
      if ("error" in rpcResponse) {
        const { error } = rpcResponse as JsonRpcErrorResponse;
        throw new RpcError(
          error.code,
          error.message,
          error.data as { code: string; [key: string]: unknown } | undefined,
        );
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

      if (attempt >= config.retries) {
        throw lastError;
      }
    }
  }

  // Should not reach here, but TypeScript needs it
  throw lastError ?? new Error("Request failed");
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
