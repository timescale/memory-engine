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

-------------------------------------------------------------------------------
-- list_space_principals
-- Principals that belong to a space, deduplicated: either added directly
-- (principal_space) or reached through a group in the space (group_member) —
-- group membership confers space access, so both count. `direct` is true when
-- the principal has a direct membership row; `admin` is its direct-membership
-- admin flag (false for group-only members). Optional kind filter
-- ('u' | 'a' | 'g'); null returns all.
-------------------------------------------------------------------------------
create or replace function {{schema}}.list_space_principals
( _space_id uuid
, _kind text default null
)
returns table
( id uuid
, kind text
, name text
, owner_id uuid
, direct bool
, admin bool
, created_at timestamptz
, updated_at timestamptz
)
as $func$
  with mem as
  (
    -- directly added to the space
    select ps.principal_id as id, true as direct, ps.admin as admin
    from {{schema}}.principal_space ps
    where ps.space_id = _space_id
    union all
    -- reached through a group belonging to the space
    select gm.member_id as id, false as direct, false as admin
    from {{schema}}.group_member gm
    where gm.space_id = _space_id
  )
  , agg as
  (
    select id, bool_or(direct) as direct, bool_or(admin) as admin
    from mem
    group by id
  )
  select p.id, p.kind, p.name::text, p.owner_id, agg.direct, agg.admin, p.created_at, p.updated_at
  from agg
  join {{schema}}.principal p on p.id = agg.id
  where (_kind is null or p.kind = _kind)
  order by p.kind, p.name
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- list_group_members
-- Members (users / agents) of a group within a space, with the admin flag.
-------------------------------------------------------------------------------
create or replace function {{schema}}.list_group_members
( _space_id uuid
, _group_id uuid
)
returns table
( member_id uuid
, kind text
, name text
, admin bool
, created_at timestamptz
)
as $func$
  select gm.member_id, p.kind, p.name::text, gm.admin, gm.created_at
  from {{schema}}.group_member gm
  join {{schema}}.principal p on p.id = gm.member_id
  where gm.space_id = _space_id
  and gm.group_id = _group_id
  order by p.name
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- list_groups_for_member
-- Groups within a space that a member (user / agent) belongs to, with the
-- admin flag.
-------------------------------------------------------------------------------
create or replace function {{schema}}.list_groups_for_member
( _space_id uuid
, _member_id uuid
)
returns table
( group_id uuid
, name text
, admin bool
, created_at timestamptz
)
as $func$
  select gm.group_id, p.name::text, gm.admin, gm.created_at
  from {{schema}}.group_member gm
  join {{schema}}.principal p on p.id = gm.group_id
  where gm.space_id = _space_id
  and gm.member_id = _member_id
  order by p.name
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
