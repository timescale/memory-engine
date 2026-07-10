-------------------------------------------------------------------------------
-- append receipts
-------------------------------------------------------------------------------
-- Operation-scoped idempotency receipts for memory.append.
--
-- Each successful append writes one receipt keyed by a caller-supplied,
-- operation-scoped `op_key` (a random key per append invocation — never
-- content-derived). A retried append that carries the same key finds the
-- receipt and REPLAYS the stored compact result instead of concatenating the
-- content a second time; a same-key request whose fingerprint differs is
-- rejected as a conflict. `request_fingerprint` is a server-computed md5 of the
-- normalized request (target id + separator + content), so it detects a key
-- reused for a materially different append.
--
-- The stored columns ARE the compact result replayed on a hit
-- (memory_id / version / version_hash / appended_bytes / content_length), so a
-- replay needs no second read of the memory row.
create table {{schema}}.append_receipt
( op_key text not null primary key
, memory_id uuid not null references {{schema}}.memory(id) on delete cascade
, request_fingerprint text not null
, version bigint not null
, version_hash text not null
, appended_bytes int not null
, content_length int not null
, created_at timestamptz not null default now()
);

-- Back the FK with an index on memory_id: without it, cascading deletes from
-- delete_memory / delete_tree seq-scan append_receipt (same lesson as
-- 003_embedding_fk_idx.sql for embedding_queue).
create index append_receipt_memory_id_idx on {{schema}}.append_receipt (memory_id);
