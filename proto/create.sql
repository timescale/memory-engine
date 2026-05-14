
-------------------------------------------------------------------------------
-- check database version
-------------------------------------------------------------------------------
select current_setting('server_version_num')::int < 180000 as bad_pg_version
\gset
\if :bad_pg_version
\warn postgres 18 or greater required
\q
\endif

-------------------------------------------------------------------------------
-- check database version
-------------------------------------------------------------------------------
select current_setting('server_version_num')::int < 180000 as bad_pg_version
\gset
\if :bad_pg_version
\warn postgres 18 or greater required
\q
\endif

-------------------------------------------------------------------------------
-- ensure extensions installed
-------------------------------------------------------------------------------
create extension if not exists citext;
create extension if not exists ltree;
create extension if not exists vector;
create extension if not exists pg_textsearch;

-------------------------------------------------------------------------------
-- database roles
-------------------------------------------------------------------------------
do $block$
declare
  _roles text[] = array['me_ro', 'me_rw', 'me_embed'];
  _role text;
  _sql text;
begin
  for _role in select * from unnest(_roles) loop
    perform
    from pg_roles r
    where r.rolname = _role;
    if found then
      continue;
    end if;
    _sql = format($sql$create role %I nologin$sql$, _role);
    execute _sql;
    _sql = format($sql$grant %I to %I$sql$, _role, current_user);
    execute _sql;
  end loop;
end;
$block$;

-------------------------------------------------------------------------------
-- engine schema
-------------------------------------------------------------------------------
drop schema if exists {{schema}} cascade;
create schema {{schema}};

-------------------------------------------------------------------------------
-- grant usage on engine schema to roles
-------------------------------------------------------------------------------
do $block$
declare
  _roles text[] = array['me_ro', 'me_rw', 'me_embed'];
  _role text;
  _sql text;
begin
  for _role in select * from unnest(_roles)
  loop
    _sql = format($sql$grant usage on schema %I to %I$sql$, '{{schema}}', _role);
    execute _sql;
  end loop;
end;
$block$;

-------------------------------------------------------------------------------
-- generic updated_at trigger
-------------------------------------------------------------------------------
create or replace function {{schema}}.update_updated_at()
returns trigger
as $func$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$func$ language plpgsql volatile security definer
set search_path to {{schema}}, pg_temp;

-------------------------------------------------------------------------------
-- users
-------------------------------------------------------------------------------
-- User: thing that accesses memories, or a role (can_login = false)
-- identity_id is a soft FK to accounts.identity (nullable for service users)
-- Note: "user" is a reserved word, must be quoted
create table {{schema}}."user"
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, name citext not null unique
, identity_id uuid check (identity_id is null or uuid_extract_version(identity_id) = 7) -- soft FK to accounts.identity
, can_login boolean not null default true  -- false = role (grant container)
, superuser boolean not null default false
, createrole boolean not null default false -- can create other users/roles
, created_at timestamptz not null default now()
, updated_at timestamptz
);

create index idx_user_identity_id on {{schema}}."user" (identity_id) where identity_id is not null;

create trigger user_updated_at
before update on {{schema}}."user"
for each row
execute function {{schema}}.update_updated_at()
;

revoke all on {{schema}}."user" from public;
grant select on {{schema}}."user" to me_ro;
grant select, insert, update, delete on {{schema}}."user" to me_rw;

-------------------------------------------------------------------------------
-- role membership
-------------------------------------------------------------------------------
create table {{schema}}.role_membership
( role_id   uuid not null references {{schema}}."user"(id) on delete cascade
, member_id uuid not null references {{schema}}."user"(id) on delete cascade
, with_admin_option boolean not null default false
, created_at timestamptz not null default now()
, primary key (role_id, member_id)
, constraint no_self_membership check (role_id != member_id)
);

create index idx_role_membership_member on {{schema}}.role_membership(member_id);

revoke all on {{schema}}.role_membership from public;
grant select on {{schema}}.role_membership to me_ro;
grant select, insert, update, delete on {{schema}}.role_membership to me_rw;

-------------------------------------------------------------------------------
-- would_create_cycle
-------------------------------------------------------------------------------
create function {{schema}}.would_create_cycle
( _role_id uuid
, _member_id uuid
)
returns boolean
as $func$
  with recursive ancestors(id) as
  (
    select rm.role_id
    from {{schema}}.role_membership rm
    where rm.member_id = _role_id
    union all
    select rm.role_id
    from {{schema}}.role_membership rm
    inner join ancestors a on a.id = rm.member_id
  )
  select _member_id = _role_id
    or exists
    (
      select 1
      from ancestors
      where id = _member_id
    )
$func$ language sql stable security invoker
parallel safe
set search_path to pg_catalog, {{schema}}, pg_temp
;

revoke all on {{schema}}.would_create_cycle(uuid, uuid) from public;
grant execute on {{schema}}.would_create_cycle(uuid, uuid) to me_rw;

-- Prevent role membership cycles for ordinary writes.
-- Note: this check observes the current transaction snapshot. Concurrent
-- transactions that insert/update related role edges can still race unless the
-- caller uses stronger locking or serializable transactions around
-- role_membership writes.
create function {{schema}}.role_membership_before_write()
returns trigger
as $func$
begin
  if {{schema}}.would_create_cycle(new.role_id, new.member_id) then
    raise exception 'role membership would create a cycle: role_id %, member_id %', new.role_id, new.member_id
      using errcode = 'integrity_constraint_violation';
  end if;

  return new;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, pg_temp
;

create trigger role_membership_before_write_trg
before insert or update of role_id, member_id on {{schema}}.role_membership
for each row
execute function {{schema}}.role_membership_before_write()
;

-------------------------------------------------------------------------------
-- tree ownership
-------------------------------------------------------------------------------
create table {{schema}}.tree_owner
( tree_path ltree not null primary key
, user_id uuid not null references {{schema}}."user" (id) on delete cascade
, created_by uuid references {{schema}}."user" (id)
, created_at timestamptz not null default now()
);

create index idx_tree_owner_user on {{schema}}.tree_owner (user_id);
create index idx_tree_owner_gist on {{schema}}.tree_owner using gist (tree_path);

revoke all on {{schema}}.tree_owner from public;
grant select on {{schema}}.tree_owner to me_ro;
grant select, insert, update, delete on {{schema}}.tree_owner to me_rw;

-------------------------------------------------------------------------------
-- tree grants
-------------------------------------------------------------------------------
create table {{schema}}.tree_grant
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, user_id uuid not null references {{schema}}."user"(id) on delete cascade
, tree_path ltree not null
, actions text[] not null check (actions <@ '{read,create,update,delete}'::text[])
, granted_by uuid references {{schema}}."user"(id)
, created_at timestamptz not null default now()
, with_grant_option boolean not null default false
);

create unique index idx_tree_grant_unique on {{schema}}.tree_grant (user_id, tree_path);
create index idx_tree_grant_path on {{schema}}.tree_grant using gist (tree_path);

revoke all on {{schema}}.tree_grant from public;
grant select on {{schema}}.tree_grant to me_ro;
grant select, insert, update, delete on {{schema}}.tree_grant to me_rw;

-------------------------------------------------------------------------------
-- memory
-------------------------------------------------------------------------------
create table {{schema}}.memory
( id uuid not null primary key default uuidv7() check (uuid_extract_version(id) = 7)
, meta jsonb not null default '{}'
, tree ltree not null default ''::ltree
, temporal tstzrange
, content text not null
, embedding halfvec({{embedding_dimensions}})
, embedding_version int4 not null default 1
, created_at timestamptz not null default now()
, created_by uuid
, updated_at timestamptz
);

revoke all on {{schema}}.memory from public;
grant select on {{schema}}.memory to me_ro;
grant select, insert, update, delete on {{schema}}.memory to me_rw;
grant select, update on {{schema}}.memory to me_embed;

-- index for faceted search
create index memory_meta_gin_idx on {{schema}}.memory using gin (meta);

-- index for temporal search
create index memory_temporal_gist_idx on {{schema}}.memory using gist (temporal) where (temporal is not null);

-- index for BM25 text search
create index memory_content_bm25_idx on {{schema}}.memory using bm25 (content)
with (text_config = {{bm25_text_config}}, k1 = {{bm25_k1}}, b = {{bm25_b}});

-- index for vector similarity search
create index memory_embedding_hnsw_idx on {{schema}}.memory using hnsw (embedding halfvec_cosine_ops)
with (m = {{hnsw_m}}, ef_construction = {{hnsw_ef_construction}});

-- index for hierarchical organization
create index memory_tree_gist_idx on {{schema}}.memory using gist (tree);

-- make sure the metadata is an object
alter table {{schema}}.memory add check (jsonb_typeof(meta) = 'object');

/*
enforce consistent temporal range conventions:
- point-in-time events: lower = upper with inclusive bounds '[same,same]'
- time periods: lower < upper with inclusive-exclusive bounds '[start,end)'
*/
alter table {{schema}}.memory add constraint temporal_bounds_convention check
(
	temporal is null
	or (
		-- point-in-time: both bounds equal and inclusive
		(lower(temporal) = upper(temporal) and lower_inc(temporal) and upper_inc(temporal))
		or
		-- time range: start before end, inclusive-exclusive
		(lower(temporal) < upper(temporal) and lower_inc(temporal) and not upper_inc(temporal))
	)
);

-------------------------------------------------------------------------------
-- memory triggers
-------------------------------------------------------------------------------
create or replace function {{schema}}.memory_before_update()
returns trigger
as $func$
begin
  -- always update the timestamp
  new.updated_at = pg_catalog.now();

  -- content changed -> new embedding needs to be generated
  if old.content is distinct from new.content
     and old.embedding is not distinct from new.embedding
  then
    new.embedding = null;
    new.embedding_version = old.embedding_version operator(pg_catalog.+) 1;
  end if;

  return new;
end;
$func$ language plpgsql volatile security definer
set search_path to {{schema}}, public, pg_temp; -- public required for pgvector's `is not distinct from`

create trigger memory_before_update_trg
before update on {{schema}}.memory
for each row
execute function {{schema}}.memory_before_update();


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
);

-- index to find items to claim
create index embedding_queue_claim_idx on {{schema}}.embedding_queue (vt) where outcome is null;
-- index also used in finding items to claim. used to ensure there aren't any items for the same memory with a newer version
create index embedding_queue_memory_idx on {{schema}}.embedding_queue (memory_id, embedding_version desc) where outcome is null;
-- index to find items that have resolved to an outcome. these can be pruned
create index embedding_queue_archive_idx on {{schema}}.embedding_queue (created_at) where outcome is not null;

grant select, update, delete on {{schema}}.embedding_queue to me_embed;

-------------------------------------------------------------------------------
-- enqueue_embedding
-------------------------------------------------------------------------------
-- this must be security definer because we won't allow me_rw to access queue directly
create or replace function {{schema}}.enqueue_embedding()
returns trigger
as $func$
begin
  insert into {{schema}}.embedding_queue (memory_id, embedding_version)
  values (new.id, new.embedding_version);
  return new;
end;
$func$
language plpgsql volatile security definer
set search_path to pg_catalog, {{schema}}, pg_temp
;

-------------------------------------------------------------------------------
-- enqueuing triggers
-------------------------------------------------------------------------------
create trigger memory_enqueue_embedding_insert
after insert on {{schema}}.memory
for each row
when (new.embedding is null) -- it's possible to insert WITH an embedding
execute function {{schema}}.enqueue_embedding()
;

create trigger memory_enqueue_embedding_update
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
( batch_size int default 10
, lock_duration interval default '5 minutes'
, max_attempts int default 3
)
returns table
( queue_id bigint
, memory_id uuid
, embedding_version int
, content text
)
as $func$
declare
  rec record;
  mem record;
  claimed_count int = 0;
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
  , last_error = coalesce(last_error, 'exceeded max attempts (worker crash)')
  where outcome is null
  and vt <= now()
  and attempts >= max_attempts
  ;

  for rec in
  (
    select
      eq.id
    , eq.memory_id
    , eq.embedding_version
    from {{schema}}.embedding_queue eq
    where eq.outcome is null
    and eq.vt <= now()
    and eq.attempts < max_attempts
    order by eq.vt
    for update skip locked
  )
  loop
    -- check memory still exists + current version
    select m.content, m.embedding_version
    into mem
    from {{schema}}.memory m
    where m.id = rec.memory_id
    ;

    if not found or mem.content is null then
      -- memory deleted or empty → cancel queue row
      update {{schema}}.embedding_queue
      set outcome = 'cancelled'
      where id = rec.id;
      continue;
    end if;

    if rec.embedding_version != mem.embedding_version then
      -- stale version → cancel
      update {{schema}}.embedding_queue
      set outcome = 'cancelled'
      where id = rec.id;
      continue;
    end if;

    -- claim this row
    update {{schema}}.embedding_queue q set
      vt = now() + lock_duration
    , attempts = q.attempts + 1
    where id = rec.id;

    queue_id = rec.id;
    memory_id = rec.memory_id;
    embedding_version = rec.embedding_version;
    content = mem.content;
    return next;

    claimed_count = claimed_count + 1;
    exit when claimed_count >= batch_size;
  end loop;
end;
$func$
language plpgsql volatile
set search_path to pg_catalog, {{schema}}, pg_temp
;

grant execute on function {{schema}}.claim_embedding_batch(int, interval, int) to me_embed;

-------------------------------------------------------------------------------
-- prune embedding queue
-------------------------------------------------------------------------------
-- prune terminal queue rows older than the retention window.
-- runs opportunistically from the worker on engines that returned no
-- claimable work, so the queue table doesn't grow unbounded.
--
-- relies on embedding_queue_archive_idx (created_at) where outcome is not null
-- from migration 005, so the no-op case is cheap.
create or replace function {{schema}}.prune_embedding_queue
( retention interval default '7 days'
)
returns bigint
as $func$
declare
  pruned bigint;
begin
  delete from {{schema}}.embedding_queue
  where outcome is not null
  and created_at < now() - retention
  ;
  get diagnostics pruned = row_count;
  return pruned;
end;
$func$
language plpgsql volatile
set search_path to pg_catalog, {{schema}}, pg_temp
;

-- me_embed already has DELETE on embedding_queue (granted in 005);
-- this just exposes the function entrypoint.
grant execute on function {{schema}}.prune_embedding_queue(interval) to me_embed;





-------------------------------------------------------------------------------
-- api keys
-------------------------------------------------------------------------------
-- Engine-scoped, user-scoped authentication
create table {{schema}}.api_key
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, user_id uuid not null references {{schema}}."user" on delete cascade
, lookup_id text unique not null check (lookup_id ~ '^[A-Za-z0-9_-]{16}$')
, key_hash text not null
, name text not null
, expires_at timestamptz
, created_at timestamptz not null default now()
, revoked_at timestamptz
);

create index idx_api_key_user on {{schema}}.api_key (user_id);
create index idx_api_key_lookup on {{schema}}.api_key (lookup_id) where revoked_at is null;


-------------------------------------------------------------------------------
-- tree access
-------------------------------------------------------------------------------
-- Returns set of tree paths the user can access for the given action.
-- Superusers get ''::ltree (empty root) which matches all paths via <@.
create function {{schema}}.tree_access
( _user_id uuid
, _action text
)
returns setof ltree
as $func$
  with recursive effective_roles(user_id) as
  (
    select _user_id
    union
    select rm.role_id
    from {{schema}}.role_membership rm
    inner join effective_roles er on (er.user_id = rm.member_id)
  )
  select distinct tree_path
  from
  (
    -- superuser: empty ltree matches everything via <@
    select ''::ltree as tree_path
    from {{schema}}."user" u
    inner join effective_roles er on (u.id = er.user_id)
    where u.superuser
    union
    -- ownership grants full access
    select o.tree_path
    from {{schema}}.tree_owner o
    inner join effective_roles er on (er.user_id = o.user_id)
    union
    -- explicit grants for the requested action
    select g.tree_path
    from {{schema}}.tree_grant g
    inner join effective_roles er on (er.user_id = g.user_id)
    where _action = any(g.actions)
  )
$func$
language sql stable security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

revoke all on function {{schema}}.tree_access(uuid, text) from public;
grant execute on function {{schema}}.tree_access(uuid, text) to me_ro, me_rw;


/*
-- ===== RLS on memory =====
alter table {{schema}}.memory enable row level security;

create policy memory_select on {{schema}}.memory
  for select to me_ro, me_rw
  using
  (
    exists
    (
      select true
      from {{schema}}.tree_access(current_setting('me.user_id', true)::uuid, 'read') ta(tree_path)
      where tree <@ ta.tree_path
    )
  );

create policy memory_insert on {{schema}}.memory
  for insert to me_rw
  with check
  (
    exists
    (
      select true
      from {{schema}}.tree_access(current_setting('me.user_id', true)::uuid, 'create') ta(tree_path)
      where tree <@ ta.tree_path
    )
  );

create policy memory_update on {{schema}}.memory
  for update to me_rw
  using
  (
    exists
    (
      select true
      from {{schema}}.tree_access(current_setting('me.user_id', true)::uuid, 'update') ta(tree_path)
      where tree <@ ta.tree_path
    )
  )
  with check
  (
    exists
    (
      select true
      from {{schema}}.tree_access(current_setting('me.user_id', true)::uuid, 'update') ta(tree_path)
      where tree <@ ta.tree_path
    )
  );

create policy memory_delete on {{schema}}.memory
  for delete to me_rw
  using
  (
    exists
    (
      select true
      from {{schema}}.tree_access(current_setting('me.user_id', true)::uuid, 'delete') ta(tree_path)
      where tree <@ ta.tree_path
    )
  );

*/
