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
language sql volatile
set search_path to pg_catalog, {{schema}}, pg_temp
as $func$
  with claimed as (
    select eq.id, eq.memory_id, eq.embedding_version
    from {{schema}}.embedding_queue eq
    where eq.outcome is null
      and eq.vt <= now()
      and eq.attempts < eq.max_attempts
    order by eq.vt
    limit batch_size
    for update skip locked
  )
  update {{schema}}.embedding_queue eq
  set vt = now() + lock_duration
    , attempts = eq.attempts + 1
  from claimed c
  where eq.id = c.id
  returning eq.id as queue_id, eq.memory_id, eq.embedding_version
    , (select m.content from {{schema}}.memory m where m.id = eq.memory_id);
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
