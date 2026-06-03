-------------------------------------------------------------------------------
-- create_user
-- Users are global (no space_id, no owner_id). The id is supplied by the caller
-- so it equals auth.users.id (one identity across auth + core).
-------------------------------------------------------------------------------
create or replace function {{schema}}.create_user
( _id uuid
, _name text
)
returns uuid
as $func$
  insert into {{schema}}.principal (id, kind, name)
  values (_id, 'u', _name)
  returning id
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- create_agent
-- Agents are owned by a user (owner_id -> a user principal's id) and are global.
-------------------------------------------------------------------------------
create or replace function {{schema}}.create_agent
( _owner_id uuid
, _name text
, _id uuid default null
)
returns uuid
as $func$
  insert into {{schema}}.principal (id, kind, name, owner_id)
  values (coalesce(_id, uuidv7()), 'a', _name, _owner_id)
  returning id
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- create_group
-- Groups belong to a single space.
-------------------------------------------------------------------------------
create or replace function {{schema}}.create_group
( _space_id uuid
, _name text
, _id uuid default null
)
returns uuid
as $func$
  insert into {{schema}}.principal (id, kind, name, space_id)
  values (coalesce(_id, uuidv7()), 'g', _name, _space_id)
  returning id
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- get_principal
-------------------------------------------------------------------------------
create or replace function {{schema}}.get_principal
( _id uuid
)
returns table
( id uuid
, kind text
, name text
, owner_id uuid
, space_id uuid
, created_at timestamptz
, updated_at timestamptz
)
as $func$
  select p.id, p.kind, p.name::text, p.owner_id, p.space_id, p.created_at, p.updated_at
  from {{schema}}.principal p
  where p.id = _id
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- get_user_by_name
-- Resolve a global user (kind 'u') by name. User names are globally unique
-- (citext), so this returns at most one row.
-------------------------------------------------------------------------------
create or replace function {{schema}}.get_user_by_name
( _name text
)
returns table
( id uuid
, kind text
, name text
, owner_id uuid
, space_id uuid
, created_at timestamptz
, updated_at timestamptz
)
as $func$
  select p.id, p.kind, p.name::text, p.owner_id, p.space_id, p.created_at, p.updated_at
  from {{schema}}.principal p
  where p.kind = 'u'
  and p.name = _name::citext
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- list_space_groups
-- All groups belonging to a space (groups are space-scoped via space_id).
-------------------------------------------------------------------------------
create or replace function {{schema}}.list_space_groups
( _space_id uuid
)
returns table
( id uuid
, name text
, created_at timestamptz
, updated_at timestamptz
)
as $func$
  select p.id, p.name::text, p.created_at, p.updated_at
  from {{schema}}.principal p
  where p.kind = 'g'
  and p.space_id = _space_id
  order by p.name
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- rename_principal
-- Rename an agent or group. Users are intentionally excluded: a user's name is
-- its email — the global identity handle that mirrors auth.users — so changing
-- it is an account concern, not a space-management one. Returns true if an
-- agent/group with this id was renamed. Name uniqueness is enforced by the
-- principal table indexes.
-------------------------------------------------------------------------------
create or replace function {{schema}}.rename_principal
( _id uuid
, _name text
)
returns bool
as $func$
  with u as
  (
    update {{schema}}.principal
    set name = _name::citext
    where id = _id
    and kind in ('a', 'g') -- never rename users (kind 'u')
    returning 1
  )
  select exists (select 1 from u)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- delete_principal
-- Delete a principal row. Foreign keys cascade: a user's agents (owner_id),
-- its space memberships, group memberships, tree-access grants, and api keys
-- all go with it. Returns true if a row was deleted.
-------------------------------------------------------------------------------
create or replace function {{schema}}.delete_principal
( _id uuid
)
returns bool
as $func$
  with d as
  (
    delete from {{schema}}.principal
    where id = _id
    returning 1
  )
  select exists (select 1 from d)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
