-------------------------------------------------------------------------------
-- add_principal_to_space
-- Adds (or updates the admin flag of) a principal's membership in a space, and
-- grants a joining user owner over its home directory. The single chokepoint
-- every join path goes through (provisioning, invite redemption, direct add),
-- so a user's membership always implies home ownership — and the one place that
-- enforces a group can only be rostered into its own space.
-------------------------------------------------------------------------------
create or replace function {{schema}}.add_principal_to_space
( _space_id uuid
, _principal_id uuid
, _admin bool default false
)
returns void
as $func$
begin
  -- A group belongs to exactly one space (principal.space_id, fixed at creation
  -- and non-null for groups), so it can only be a member of that space; reject
  -- adding it to a different one. Users and agents are global (space_id null),
  -- so this constrains groups only.
  if exists
  (
    select 1
    from {{schema}}.principal p
    where p.id = _principal_id
    and p.kind = 'g'
    and p.space_id is distinct from _space_id
  ) then
    raise exception
      'group % cannot be added to space %: it belongs to a different space', _principal_id, _space_id
      using errcode = '23514'
      , hint = 'a group can only be a member of the space it was created in';
  end if;

  insert into {{schema}}.principal_space (space_id, principal_id, admin)
  values (_space_id, _principal_id, _admin)
  on conflict (principal_id, space_id) do update set
    admin = excluded.admin; -- updated_at maintained by the before-update trigger

  -- A user owns its home directory (home.<user_id>, hyphens stripped); see
  -- packages/database/space/path.ts homePrefix() for the matching client form.
  -- Users only: an agent's effective grants are clamped to its owner's by
  -- agent_tree_access, so an auto home grant would be inert (the owner has no
  -- access over the agent's home); groups have no home either. Idempotent and
  -- non-clobbering: an existing home grant is left untouched.
  insert into {{schema}}.tree_access (space_id, principal_id, tree_path, access)
  select _space_id, _principal_id
       , ('home.' || replace(_principal_id::text, '-', ''))::ltree
       , 3 -- owner
  from {{schema}}.principal p
  where p.id = _principal_id
  and p.kind = 'u'
  on conflict (space_id, principal_id, tree_path) do nothing;
end;
$func$ language plpgsql volatile security invoker
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
-- the principal has a direct membership row; `admin` is its EFFECTIVE space-admin
-- status, via is_principal_space_admin (a direct admin row OR membership of an
-- admin group, never an agent) — so a user who is admin only through an admin
-- group is reported admin=true, matching is_principal_space_admin. Optional kind
-- filter ('u' | 'a' | 'g'); null returns all.
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
    select ps.principal_id as id, true as direct
    from {{schema}}.principal_space ps
    where ps.space_id = _space_id
    union all
    -- reached through a group belonging to the space
    select gm.member_id as id, false as direct
    from {{schema}}.group_member gm
    where gm.space_id = _space_id
  )
  , agg as
  (
    select id, bool_or(direct) as direct
    from mem
    group by id
  )
  select p.id, p.kind, p.name::text, p.owner_id
       , agg.direct
       , {{schema}}.is_principal_space_admin(p.id, _space_id) as admin
       , p.created_at, p.updated_at
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
