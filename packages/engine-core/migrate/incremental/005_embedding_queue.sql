-------------------------------------------------------------------------------
-- embedding queue
-------------------------------------------------------------------------------
-- per-engine embedding queue table
create table {{schema}}.embedding_queue
( id bigint generated always as identity primary key
, memory_id uuid not null references {{schema}}.memory(id) on delete cascade
, embedding_version int not null
, vt timestamptz not null default now()
, outcome text check (outcome is null or outcome in ('completed', 'failed', 'cancelled'))
, attempts int not null default 0
, last_error text
, created_at timestamptz not null default now()
, updated_at timestamptz
);

-- index to find items to claim
create index embedding_queue_claim_idx on {{schema}}.embedding_queue (vt) where outcome is null;
-- index also used in finding items to claim. used to ensure there aren't any items for the same memory with a newer version
create index embedding_queue_memory_idx on {{schema}}.embedding_queue (memory_id, embedding_version desc) where outcome is null;
-- index to find items that have resolved to an outcome. these can be pruned
create index embedding_queue_archive_idx on {{schema}}.embedding_queue (created_at) where outcome is not null;
