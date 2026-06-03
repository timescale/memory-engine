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
