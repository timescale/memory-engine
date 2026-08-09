// 0.0.7: adds the metaPredicate jsonpath argument to search_memory and
// hybrid_search_memory (idempotent 002_search.sql).
// Idempotent migrations currently re-run on every migrate pass (the
// equal-version early-return in migrate/kit.ts is deliberately commented
// out), so the bump is not what delivers the function. It marks the schema
// change and arms the ACTIVE downgrade guard: an older application (≤0.0.6,
// which doesn't know these arguments) refuses to migrate a database stamped
// 0.0.7 instead of quietly re-running its older idempotent set against it.
export const SPACE_SCHEMA_VERSION = "0.0.7";
