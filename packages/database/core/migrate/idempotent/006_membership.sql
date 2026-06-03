-------------------------------------------------------------------------------
-- add_principal_to_space
-- Adds (or updates the admin flag of) a principal's membership in a space.
-------------------------------------------------------------------------------
create or replace function {{schema}}.add_principal_to_space
( _space_id uuid
, _principal_id uuid
, _admin bool default false
)
returns void
as $func$
  insert into {{schema}}.principal_space (space_id, principal_id, admin)
  values (_space_id, _principal_id, _admin)
  on conflict (principal_id, space_id) do update set
    admin = excluded.admin -- updated_at maintained by the before-update trigger
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- add_group_member
-- Adds a user/agent member to a group within a space.
-------------------------------------------------------------------------------
create or replace function {{schema}}.add_group_member
( _space_id uuid
, _group_id uuid
, _member_id uuid
, _admin bool default false
)
returns void
as $func$
  insert into {{schema}}.group_member (space_id, group_id, member_id, admin)
  values (_space_id, _group_id, _member_id, _admin)
  on conflict (space_id, member_id, group_id) do update set
    admin = excluded.admin -- updated_at maintained by the before-update trigger
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- remove_principal_from_space
-- Removes a principal from a space and cascades: scrubs its tree_access grants
-- and its group_member rows in that space (both as a member and, if it is a
-- group, its members). Returns true if the principal was a member of the space.
-- (Space-scoped only; the principal row itself and any other spaces are left
-- untouched.)
-------------------------------------------------------------------------------
create or replace function {{schema}}.remove_principal_from_space
( _space_id uuid
, _principal_id uuid
)
returns bool
as $func$
  with del_grants as
  (
    delete from {{schema}}.tree_access
    where space_id = _space_id
    and principal_id = _principal_id
  )
  , del_group_member as
  (
    delete from {{schema}}.group_member
    where space_id = _space_id
    and (member_id = _principal_id or group_id = _principal_id)
  )
  , del_membership as
  (
    delete from {{schema}}.principal_space
    where space_id = _space_id
    and principal_id = _principal_id
    returning 1
  )
  select exists (select 1 from del_membership)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- remove_group_member
-- Removes a member from a group within a space. Returns true if a row was removed.
-------------------------------------------------------------------------------
create or replace function {{schema}}.remove_group_member
( _space_id uuid
, _group_id uuid
, _member_id uuid
)
returns bool
as $func$
  with d as
  (
    delete from {{schema}}.group_member
    where space_id = _space_id
    and group_id = _group_id
    and member_id = _member_id
    returning 1
  )
  select exists (select 1 from d)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
