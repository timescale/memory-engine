-------------------------------------------------------------------------------
-- grant_tree_access
-- Grants (or updates) a principal's access at a tree path in a space.
-- access: 1 = read, 2 = write, 3 = owner. Access is purely additive (grants);
-- there are no deny entries.
-------------------------------------------------------------------------------
create or replace function {{schema}}.grant_tree_access
( _space_id uuid
, _principal_id uuid
, _tree_path ltree
, _access int
)
returns void
as $func$
  insert into {{schema}}.tree_access (space_id, principal_id, tree_path, access)
  values (_space_id, _principal_id, _tree_path, _access)
  on conflict (space_id, principal_id, tree_path) do update set
    access = excluded.access -- updated_at maintained by the before-update trigger
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- remove_tree_access_grant
-- Removes a single grant. Returns true if a row was removed. (No deny perms,
-- so removing a grant simply drops that access.)
-------------------------------------------------------------------------------
create or replace function {{schema}}.remove_tree_access_grant
( _space_id uuid
, _principal_id uuid
, _tree_path ltree
)
returns bool
as $func$
  with d as
  (
    delete from {{schema}}.tree_access
    where space_id = _space_id
    and principal_id = _principal_id
    and tree_path = _tree_path
    returning 1
  )
  select exists (select 1 from d)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- list_tree_access_grants
-- The grant rows in a space, optionally for a single principal. (Owner listing
-- is this filtered to access = 3 by the caller.) Distinct from build_tree_access,
-- which resolves a member's *effective* access set; this lists the raw grants.
-------------------------------------------------------------------------------
create or replace function {{schema}}.list_tree_access_grants
( _space_id uuid
, _principal_id uuid default null
)
returns table
( principal_id uuid
, tree_path text
, access int
, created_at timestamptz
, updated_at timestamptz
)
as $func$
  select t.principal_id, t.tree_path::text, t.access, t.created_at, t.updated_at
  from {{schema}}.tree_access t
  where t.space_id = _space_id
  and (_principal_id is null or t.principal_id = _principal_id)
  order by t.principal_id, t.tree_path
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
