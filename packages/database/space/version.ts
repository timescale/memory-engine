// 0.0.6: adds the reconcile_tree function (idempotent 001_memory.sql). The
// version gate skips ALL migrations — idempotents included — when the db
// already matches, so a new function must bump this or existing spaces never
// receive it (fresh CI schemas would mask the gap).
export const SPACE_SCHEMA_VERSION = "0.0.6";
