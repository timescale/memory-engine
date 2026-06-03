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
