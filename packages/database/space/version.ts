// 0.0.10: adds the _cursor uuid argument to search_memory (idempotent 002_search.sql).
// Incremental migrations run once, while idempotents re-run on every migrate
// pass. The schema version arms the downgrade guard for older applications.
export const SPACE_SCHEMA_VERSION = "0.0.10";
