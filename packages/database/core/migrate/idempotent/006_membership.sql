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
-- Adds a user/agent member to a group within a space. Groups are NOT nestable:
-- a group can never be a group member. This is already structurally impossible
-- (group_member.member_id references principal(member_id), which is null for
-- groups, so a group id can't be inserted), but we reject it explicitly first so
-- the caller gets a clear message instead of an opaque foreign-key violation.
-------------------------------------------------------------------------------
create or replace function {{schema}}.add_group_member
( _space_id uuid
, _group_id uuid
, _member_id uuid
, _admin bool default false
)
returns void
as $func$
begin
  if exists
  (
    select 1
    from {{schema}}.principal p
    where p.id = _member_id
    and p.kind = 'g'
  ) then
    raise exception
      'cannot add group % as a member of group %: groups are not nestable', _member_id, _group_id
      using errcode = '23514'
      , hint = 'group members must be users or agents, not groups';
  end if;

  insert into {{schema}}.group_member (space_id, group_id, member_id, admin)
  values (_space_id, _group_id, _member_id, _admin)
  on conflict (space_id, member_id, group_id) do update set
    admin = excluded.admin; -- updated_at maintained by the before-update trigger
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- set_group_is_space_admin
-- Promote/demote a group to/from an ADMIN GROUP of its space — toggles the
-- group's own principal_space.admin. (Distinct from a group MEMBER's admin
-- flag, group_member.admin, which governs the group's own membership.) An admin
-- group's space-admin authority flows to its direct-member users
-- (is_principal_space_admin); group membership alone still confers nothing.
-- Operates on the group's existing roster row (a group is rostered on creation),
-- so it's an UPDATE, not an upsert. Demotion is guarded by enforce_last_admin
-- (the principal_space_keep_admin_upd constraint trigger) — it can't strip the
-- space's last effective admin. Rejects a non-group principal. Returns true if
-- the group's roster row actually changed (a no-op toggle returns false).
--
-- (Renamed from set_group_admin to disambiguate from a group MEMBER's admin
-- flag; drop the old name in case a pre-rename branch migration installed it.)
-------------------------------------------------------------------------------
drop function if exists {{schema}}.set_group_admin(uuid, uuid, bool);

create or replace function {{schema}}.set_group_is_space_admin
( _space_id uuid
, _group_id uuid
, _is_space_admin bool
)
returns bool
as $func$
declare
  _updated bool;
begin
  if not exists
  (
    select 1
    from {{schema}}.principal p
    where p.id = _group_id
    and p.kind = 'g'
  ) then
    raise exception
      'principal % is not a group', _group_id
      using errcode = '22023'
      , hint = 'set_group_is_space_admin applies only to groups';
  end if;

  with upd as
  (
    update {{schema}}.principal_space
    set admin = _is_space_admin
    where principal_id = _group_id
    and space_id = _space_id
    and admin is distinct from _is_space_admin
    returning 1
  )
  select exists (select 1 from upd) into _updated;

  return _updated;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- remove_principal_from_space
-- Removes a user/agent member from a space and cascades: scrubs its tree_access
-- grants and its group_member rows in that space. Returns true if the principal
-- was a member of the space. (Space-scoped only; the principal row itself and
-- any other spaces are left untouched.)
--
-- User → agent cascade: removing a USER also deprovisions the agents that user
-- owns from THIS space (their tree_access / group_member / principal_space rows),
-- because an agent is a separate principal nested under its owner's home and would
-- otherwise stay rostered and usable via its own api key after its owner leaves.
-- The cascade is space-scoped (only rows in _space_id) — the agents' `principal`
-- rows and their memberships in other spaces are left intact — and gated on the
-- target actually having been a member, so removing a non-member is a clean no-op.
-- It lives here so every caller (admin remove-member, self-leave) inherits it
-- atomically; agents are never admins, so the agent-row deletes can't trip the
-- deferred enforce_last_admin guard.
--
-- Groups are rejected: a group is rostered into its space on creation
-- (create_group → add_principal_to_space) and leaves only when the group itself
-- is deleted (delete_principal, which cascades its principal_space / group_member
-- / tree_access rows). Removing just the roster row here would orphan the group —
-- it would still exist in `principal` (resolvable via list_space_groups) but
-- vanish from the roster (list_space_principals / principal.resolve) and lose its
-- grants, re-creating the TNT-160 "group not on the roster" state.
-------------------------------------------------------------------------------
create or replace function {{schema}}.remove_principal_from_space
( _space_id uuid
, _principal_id uuid
)
returns bool
as $func$
declare
  _removed bool;
begin
  if exists
  (
    select 1
    from {{schema}}.principal p
    where p.id = _principal_id
    and p.kind = 'g'
  ) then
    raise exception
      'cannot remove group % from space %: delete the group instead', _principal_id, _space_id
      using errcode = '23514'
      , hint = 'a group leaves a space only by being deleted (group delete / delete_principal)';
  end if;

  -- The data-modifying CTEs must sit at the top level of the statement (Postgres
  -- forbids them inside a subquery / EXISTS), so collect the result via SELECT INTO.
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
    and member_id = _principal_id
  )
  , del_membership as
  (
    delete from {{schema}}.principal_space
    where space_id = _space_id
    and principal_id = _principal_id
    returning 1
  )
  select exists (select 1 from del_membership) into _removed;

  -- User → agent cascade (space-scoped). Only when the target was actually a
  -- member and is a user: deprovision the agents it owns from this space too.
  if _removed and exists
  (
    select 1
    from {{schema}}.principal p
    where p.id = _principal_id
    and p.kind = 'u'
  ) then
    with owned_agents as
    (
      select p.id
      from {{schema}}.principal p
      where p.kind = 'a'
      and p.owner_id = _principal_id
    )
    , del_agent_grants as
    (
      delete from {{schema}}.tree_access
      where space_id = _space_id
      and principal_id in (select id from owned_agents)
    )
    , del_agent_group_member as
    (
      delete from {{schema}}.group_member
      where space_id = _space_id
      and member_id in (select id from owned_agents)
    )
    delete from {{schema}}.principal_space
    where space_id = _space_id
    and principal_id in (select id from owned_agents);
  end if;

  return _removed;
end;
$func$ language plpgsql volatile security invoker
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
-- The space roster: principals with a direct membership row (principal_space) —
-- users, agents, AND groups (a group is rostered into its space on creation, so
-- principal_space is the single source of truth for who/what belongs to a space).
-- Note the distinction: a group appears here because it is itself a roster entry;
-- this says nothing about its members — a user/agent who is only in a group (no
-- principal_space row of their own) is still NOT a space member and is not listed.
-- `admin` is the EFFECTIVE space-admin status via is_principal_space_admin (a
-- direct admin row OR a direct member who belongs to an admin group, never an
-- agent; false for a group rostered admin=false). Optional kind filter
-- ('u' | 'a' | 'g'); null returns all.
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
