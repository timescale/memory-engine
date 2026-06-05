
-------------------------------------------------------------------------------
-- enqueue_embedding
-------------------------------------------------------------------------------
create or replace function {{schema}}.enqueue_embedding()
returns trigger
as $func$
begin
  insert into {{schema}}.embedding_queue (memory_id, embedding_version)
  values (new.id, new.embedding_version);
  return new;
end;
$func$
language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, pg_temp
;

create or replace trigger memory_enqueue_embedding_insert
after insert on {{schema}}.memory
for each row
when (new.embedding is null) -- it's possible to insert with an embedding
execute function {{schema}}.enqueue_embedding()
;

create or replace trigger memory_enqueue_embedding_update
after update on {{schema}}.memory
for each row
when
( old.content is distinct from new.content
  and new.embedding is null
)
execute function {{schema}}.enqueue_embedding()
;

-------------------------------------------------------------------------------
-- claim_embedding_batch
-------------------------------------------------------------------------------
create or replace function {{schema}}.claim_embedding_batch
( _batch_size int default 10
, _lock_duration interval default '5 minutes'
, _max_attempts int default 3
)
returns table
( queue_id bigint
, memory_id uuid
, embedding_version int
, content text
)
as $func$
declare
  _rec record;
  _mem record;
  _claimed_count int = 0;
begin
  -- bulk-cancel visible queue rows superseded by a newer row for the same memory
  update {{schema}}.embedding_queue eq
  set outcome = 'cancelled'
  where eq.outcome is null
  and eq.vt <= now()
  and exists
  (
    select 1
    from {{schema}}.embedding_queue newer
    where newer.memory_id = eq.memory_id
    and newer.embedding_version > eq.embedding_version
    and newer.outcome is null
  );

  -- sweep: finalize exhausted rows orphaned by worker crash
  -- (attempts reached max but outcome was never written back)
  update {{schema}}.embedding_queue
  set
    outcome = 'failed'
  , last_error = coalesce(last_error, 'exceeded max attempts')
  where outcome is null
  and vt <= now()
  and attempts >= _max_attempts
  ;

  for _rec in
  (
    select
      eq.id
    , eq.memory_id
    , eq.embedding_version
    from {{schema}}.embedding_queue eq
    where eq.outcome is null
    and eq.vt <= now()
    and eq.attempts < _max_attempts
    order by eq.vt
    for update skip locked
  )
  loop
    -- check memory still exists + current version
    select m.content, m.embedding_version
    into _mem
    from {{schema}}.memory m
    where m.id = _rec.memory_id
    ;

    if not found or _mem.content is null then
      -- memory deleted or empty → cancel queue row
      update {{schema}}.embedding_queue
      set outcome = 'cancelled'
      where id = _rec.id;
      continue;
    end if;

    if _rec.embedding_version != _mem.embedding_version then
      -- stale version → cancel
      update {{schema}}.embedding_queue
      set outcome = 'cancelled'
      where id = _rec.id;
      continue;
    end if;

    -- claim this row
    update {{schema}}.embedding_queue q set
      vt = now() + _lock_duration
    , attempts = q.attempts + 1
    where id = _rec.id;

    queue_id = _rec.id;
    memory_id = _rec.memory_id;
    embedding_version = _rec.embedding_version;
    content = _mem.content;
    return next;

    _claimed_count = _claimed_count + 1;
    exit when _claimed_count >= _batch_size;
  end loop;
end;
$func$
language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, pg_temp
;

-------------------------------------------------------------------------------
-- prune embedding queue
-------------------------------------------------------------------------------
-- prune terminal queue rows older than the retention window.
-- runs opportunistically from the worker on spaces that returned no
-- claimable work, so the queue table doesn't grow unbounded.
--
-- relies on embedding_queue_archive_idx (created_at) where outcome is not null
-- from migration 005, so the no-op case is cheap.
create or replace function {{schema}}.prune_embedding_queue(_retention interval default '7 days')
returns bigint
as $func$
declare
  pruned bigint;
begin
  delete from {{schema}}.embedding_queue
  where outcome is not null
  and created_at < now() - _retention
  ;
  get diagnostics pruned = row_count;
  return pruned;
end;
$func$
language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, pg_temp
;

-------------------------------------------------------------------------------
-- write-back: complete_embedding / fail_embedding / release_embedding
-- The worker claims with claim_embedding_batch, generates embeddings out of
-- band, then finalizes each row through one of these (so the worker holds no
-- inline SQL). Claim and write-back are separate transactions; on a transient
-- failure the row keeps outcome NULL and becomes claimable again after its
-- visibility timeout.
-------------------------------------------------------------------------------

-- Version-guarded write-back. Writes the embedding to the memory only if its
-- embedding_version still matches the claimed version, then finalizes the queue
-- row: 'completed' when written, 'cancelled' when the memory was superseded
-- (content changed → newer version) or deleted in the meantime. Atomic; returns
-- the outcome.
create or replace function {{schema}}.complete_embedding
( _queue_id bigint
, _memory_id uuid
, _embedding_version int
, _embedding halfvec
)
returns text
as $func$
declare
  _updated int;
  _outcome text;
begin
  update {{schema}}.memory
  set embedding = _embedding
  where id = _memory_id
  and embedding_version = _embedding_version
  ;
  get diagnostics _updated = row_count;

  _outcome = case when _updated > 0 then 'completed' else 'cancelled' end;

  update {{schema}}.embedding_queue
  set outcome = _outcome
  where id = _queue_id
  ;
  return _outcome;
end;
$func$
language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, pg_temp
;

-- Record a transient embedding error without finalizing: leaves outcome NULL so
-- the row retries (the claim sweep fails it once attempts are exhausted). No-op
-- when the row is already terminal or was CASCADE-deleted with its memory.
create or replace function {{schema}}.fail_embedding
( _queue_id bigint
, _error text
)
returns void
as $func$
  update {{schema}}.embedding_queue
  set last_error = _error
  where id = _queue_id
  and outcome is null
  ;
$func$
language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, pg_temp
;

-- Undo a claim for a transient rate limit — the inverse of claim_embedding_batch:
-- decrement attempts (the rate limit must not consume the attempt budget) AND
-- reset the visibility timeout so the row is immediately claimable again.
-- Without resetting vt the row would sit out the full claim lock (~minutes)
-- before retrying; the worker's own rate-limit backoff (honoring Retry-After)
-- paces the actual retry. No-op once the row is terminal.
create or replace function {{schema}}.release_embedding
( _queue_id bigint
)
returns void
as $func$
  update {{schema}}.embedding_queue
  set attempts = greatest(attempts - 1, 0)
    , vt = now()
  where id = _queue_id
  and outcome is null
  ;
$func$
language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, pg_temp
;
