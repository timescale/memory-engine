// 0.0.6: adds the delete_orphans_in_tree function (idempotent 001_memory.sql).
// Idempotent migrations currently re-run on every migrate pass (the
// equal-version early-return in migrate/kit.ts is deliberately commented
// out), so the bump is not what delivers the function. It marks the schema
// change and arms the ACTIVE downgrade guard: an older application (≤0.0.5,
// which doesn't know this function) refuses to migrate a database stamped
// 0.0.6 instead of quietly re-running its older idempotent set against it.
// 0.0.7: adds the per-space append_receipt table (incremental 008) and the
// append_memory function (idempotent 001_memory.sql) for memory.append. Arms
// the downgrade guard: an older application (≤0.0.6) refuses to migrate a
// database stamped 0.0.7 rather than run its append-unaware migration set.
export const SPACE_SCHEMA_VERSION = "0.0.7";
