// 0.0.9: adds the append-only memory_event audit log (incremental 008).
// Incremental migrations run once, while idempotents re-run on every migrate
// pass. The schema version arms the downgrade guard for older applications.
export const SPACE_SCHEMA_VERSION = "0.0.9";
