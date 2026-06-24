-------------------------------------------------------------------------------
-- add_principal_to_space
-- Adds (or updates the admin flag of) a principal's membership in a space, and
-- grants a joining user/agent owner over its home directory. The single
-- chokepoint every join path goes through (provisioning, invite redemption,
-- direct add), so a member's membership always implies home ownership — and the
-- one place that enforces a group can only be rostered into its own space.
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

  -- A joining member owns its home directory; the path differs by kind (hyphens
  -- stripped to valid ltree labels; see packages/database/space/path.ts
  -- homePrefix() for the matching client form):
  --   user  -> home.<user_id>
  --   agent -> home.<owner_id>.<agent_id>   (nested under the owner's home)
  -- The agent's home nests under its owner's home so the owner's
  -- owner@home.<owner_id> grant covers it and agent_tree_access keeps the grant
  -- effective (a bare home.<agent_id> would be clamped to nothing — the owner
  -- holds no access there). Groups have no home. Idempotent and non-clobbering:
  -- an existing home grant is left untouched.
  insert into {{schema}}.tree_access (space_id, principal_id, tree_path, access)
  select _space_id, _principal_id
       , case
           when p.kind = 'a'
             then ('home.' || replace(p.owner_id::text, '-', '') || '.' || replace(p.id::text, '-', ''))::ltree
           else ('home.' || replace(p.id::text, '-', ''))::ltree
         end
       , 3 -- owner
  from {{schema}}.principal p
  where p.id = _principal_id
  and p.kind in ('u', 'a')
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
-- The space roster: principals with a direct membership row (principal_space).
-- Group membership alone does NOT make you a space member, so group-only
-- principals are not listed. `admin` is the EFFECTIVE space-admin status via
-- is_principal_space_admin (a direct admin row OR a direct member who belongs to
-- an admin group, never an agent). Optional kind filter ('u' | 'a' | 'g'); null
-- returns all.
-------------------------------------------------------------------------------
-- list_space_principals dropped its `direct` output column — a returns-table
-- change create-or-replace cannot make. The fn block drops a stale-signatured
-- definition before the create and asserts the result after.
{{fn list_space_principals(_space_id uuid, _kind text) returns table(id uuid, kind text, name text, owner_id uuid, admin bool, created_at timestamptz, updated_at timestamptz)}}
create or replace function {{schema}}.list_space_principals
( _space_id uuid
, _kind text default null
)
returns table
( id uuid
, kind text
, name text
, owner_id uuid
, admin bool
, created_at timestamptz
, updated_at timestamptz
)
as $func$
  select p.id, p.kind, p.name::text, p.owner_id
       , {{schema}}.is_principal_space_admin(p.id, _space_id) as admin
       , p.created_at, p.updated_at
  from {{schema}}.principal_space ps
  join {{schema}}.principal p on p.id = ps.principal_id
  where ps.space_id = _space_id
  and (_kind is null or p.kind = _kind)
  order by p.kind, p.name
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

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
