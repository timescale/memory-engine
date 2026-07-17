import type { CoreStore } from "@memory.build/engine/core";
import { warning } from "@pydantic/logfire-node";

// Best-effort day-level api-key usage recording. Validation stays read-only
// (`core.validateApiKey`); this helper writes `last_used_on` at most once per
// key per UTC day per server process. The cache below is a MODULE-GLOBAL
// singleton: every caller in the process shares the same map, which is what
// keeps the hot path to a Map lookup. Tests that call `recordApiKeyUse`
// therefore share state — use `resetApiKeyUsageCacheForTest` in `beforeEach`,
// or make sure every test mints a fresh key id (the middleware integration
// tests rely on that latter property).

const CACHE_FLUSH_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Soft upper bound on the cache. The threshold is compared *before* the
// current call inserts, so the map is bounded at `MAX_CACHE_ENTRIES + 1`
// entries in the worst case — the +1 falls off on the next call that trips
// the check. This is deliberate: the goal is a memory ceiling, not a hard
// count. A same-day miss just costs one extra no-op `touch_api_key` (the SQL
// predicate skips the update when `last_used_on` already equals today).
const MAX_CACHE_ENTRIES = 10_000;

const touchedByProcess = new Map<string, string>();
let lastFlushMs = Date.now();

function maybeFlushCache(nowMs = Date.now()): void {
  if (
    touchedByProcess.size > MAX_CACHE_ENTRIES ||
    nowMs - lastFlushMs >= CACHE_FLUSH_INTERVAL_MS
  ) {
    touchedByProcess.clear();
    lastFlushMs = nowMs;
  }
}

export async function recordApiKeyUse(
  core: CoreStore,
  apiKeyId: string,
  now = new Date(),
): Promise<void> {
  maybeFlushCache(now.getTime());

  const usedOn = now.toISOString().slice(0, 10);
  if (touchedByProcess.get(apiKeyId) === usedOn) return;

  // Set BEFORE the write so a temporary DB failure cannot cause per-request
  // retries against the same broken database. The SQL predicate keeps row
  // churn to one update per day even if a later process crash lets this cache
  // reset early.
  touchedByProcess.set(apiKeyId, usedOn);

  try {
    await core.touchApiKey(apiKeyId, usedOn);
  } catch (error) {
    // Best-effort telemetry — auth already succeeded, so a touch failure
    // must not fail the request. `warning` (not `debug`) so a persistent
    // outage is visible in production logs; a same-key retry storm is
    // already prevented by the cache-first write above.
    warning("api key usage touch failed", {
      apiKeyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function resetApiKeyUsageCacheForTest(now = new Date()): void {
  touchedByProcess.clear();
  lastFlushMs = now.getTime();
}

/** Test-only inspector for the module-global cache size. */
export function apiKeyUsageCacheSizeForTest(): number {
  return touchedByProcess.size;
}
