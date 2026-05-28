
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
