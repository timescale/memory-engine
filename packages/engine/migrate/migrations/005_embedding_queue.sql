-- per-engine embedding queue table
create table {{schema}}.embedding_queue
( id                bigint generated always as identity primary key
, memory_id         uuid not null references {{schema}}.memory(id) on delete cascade
, embedding_version int not null
, vt                timestamptz not null default now()
, outcome           text check (outcome is null or outcome in ('completed', 'failed', 'cancelled'))
, attempts          int not null default 0
, max_attempts      int not null default 3
, last_error        text
, created_at        timestamptz not null default now()
);

create index embedding_queue_claim_idx
  on {{schema}}.embedding_queue (vt)
  where outcome is null;
create index embedding_queue_memory_idx
  on {{schema}}.embedding_queue (memory_id, embedding_version desc)
  where outcome is null;
create index embedding_queue_archive_idx
  on {{schema}}.embedding_queue (created_at)
  where outcome is not null;

-- enqueue function (SECURITY DEFINER — me_rw cannot access queue directly)
create or replace function {{schema}}.enqueue_embedding()
returns trigger
language plpgsql volatile security definer
set search_path to pg_catalog, {{schema}}, pg_temp
as $func$
begin
  insert into {{schema}}.embedding_queue (memory_id, embedding_version)
  values (new.id, new.embedding_version);
  return new;
end;
$func$;

-- enqueue triggers
create trigger memory_enqueue_embedding_insert
  after insert on {{schema}}.memory
  for each row
  when (new.embedding is null)
  execute function {{schema}}.enqueue_embedding();

create trigger memory_enqueue_embedding_update
  after update on {{schema}}.memory
  for each row
  when (old.content is distinct from new.content
    and new.embedding is null
    and new.embedding_attempts < 3)
  execute function {{schema}}.enqueue_embedding();

-- claim function for embedding worker
create or replace function {{schema}}.claim_embedding_batch(
  batch_size int default 10,
  lock_duration interval default '5 minutes'
)
returns table (queue_id bigint, memory_id uuid, embedding_version int, content text)
language plpgsql volatile
set search_path to pg_catalog, {{schema}}, pg_temp
as $func$
declare
  rec record;
  mem record;
  claimed_count int := 0;
begin
  -- bulk-cancel visible queue rows superseded by a newer row for the same memory
  update {{schema}}.embedding_queue eq
  set outcome = 'cancelled'
  where eq.outcome is null
    and eq.vt <= now()
    and exists (
      select 1
      from {{schema}}.embedding_queue newer
      where newer.memory_id = eq.memory_id
        and newer.embedding_version > eq.embedding_version
        and newer.outcome is null
    );

  -- sweep: finalize exhausted rows orphaned by worker crash
  -- (attempts reached max but outcome was never written back)
  update {{schema}}.embedding_queue
  set outcome = 'failed'
    , last_error = coalesce(last_error, 'exceeded max attempts (worker crash)')
  where outcome is null
    and vt <= now()
    and attempts >= max_attempts;

  for rec in
    select eq.id, eq.memory_id, eq.embedding_version
    from {{schema}}.embedding_queue eq
    where eq.outcome is null
      and eq.vt <= now()
      and eq.attempts < eq.max_attempts
    order by eq.vt
    for update skip locked
  loop
    -- check memory still exists + current version
    select m.content, m.embedding_version
    into mem
    from {{schema}}.memory m
    where m.id = rec.memory_id;

    if not found or mem.content is null then
      -- memory deleted or empty → cancel queue row
      update {{schema}}.embedding_queue
      set outcome = 'cancelled'
      where id = rec.id;
      continue;
    end if;

    if rec.embedding_version <> mem.embedding_version then
      -- stale version → cancel
      update {{schema}}.embedding_queue
      set outcome = 'cancelled'
      where id = rec.id;
      continue;
    end if;

    -- claim this row
    update {{schema}}.embedding_queue
    set vt = now() + lock_duration
      , attempts = {{schema}}.embedding_queue.attempts + 1
    where id = rec.id;

    queue_id := rec.id;
    memory_id := rec.memory_id;
    embedding_version := rec.embedding_version;
    content := mem.content;
    return next;

    claimed_count := claimed_count + 1;
    exit when claimed_count >= batch_size;
  end loop;
end;
$func$;

-- me_embed RLS — system role, unrestricted access to all memories
create policy memory_embed_select on {{schema}}.memory
  for select to me_embed
  using (true);

create policy memory_embed_update on {{schema}}.memory
  for update to me_embed
  using (true);

-- me_embed grants (memory + queue + claim function)
grant usage on schema {{schema}} to me_embed;
grant select, update on {{schema}}.memory to me_embed;
grant select, update, delete on {{schema}}.embedding_queue to me_embed;
grant execute on function {{schema}}.claim_embedding_batch(int, interval) to me_embed;
