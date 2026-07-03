-------------------------------------------------------------------------------
-- provision_default_group
-- Creates a space's default group (idempotently) and — unless opted out — sets
-- its standard grants: read on `share`, write on `share.projects`. Called in the
-- space-creation transaction (see packages/server/provision.ts addSpaceCreator)
-- when a default group is requested.
--
-- Custom spaces: two provisioning-time inputs —
--   _name          : the group's name (default 'team'); e.g. 'public', 'readers'.
--   _grant_defaults: when false, the group is created but left GRANTLESS, so the
--                    operator configures its access by hand (a grantless-but-
--                    present default group still anchors the invite default, so
--                    a later grant on it activates retroactively for members).
-- Opting out of a default group ENTIRELY is expressed by not calling this at all
-- (there is no auto_grant_team column — group grants are just tree_access rows).
--
-- The created group is flagged is_default_group (via create_group), which is the
-- single marker the invite default and space read resolve against. Idempotency
-- keys on that flag (rename-proof) rather than the literal name.
--
-- Delegates group creation to create_group, so the group is rostered into
-- principal_space (the single source of truth for space membership — see
-- TNT-160) as a NON-admin group. The group starts memberless, so its grants are
-- dormant: member_tree_access yields nothing until a member is added.
--
-- Existing spaces are backfilled by the one-time incremental migrations
-- 012_default_groups.sql (the 'team' group) and 014_space_access_defaults.sql
-- (flags it is_default_group), which deliberately inline their intent rather than
-- calling this function: incrementals run before idempotents (this file is
-- idempotent), so this function does not yet exist when the backfills run, and a
-- one-time migration should stay frozen regardless of how this living function
-- later evolves.
--
-- Returns the group id (created or pre-existing). Idempotent: a re-call is a
-- no-op — the group is created only when absent, and grant_tree_access upserts
-- the grants in place.
-------------------------------------------------------------------------------
{{fn provision_default_group(_space_id uuid, _name text, _grant_defaults bool) returns uuid}}
create or replace function {{schema}}.provision_default_group
( _space_id uuid
, _name text default 'team'
, _grant_defaults bool default true
)
returns uuid
as $func$
declare
  _group_id uuid;
begin
  -- rename-proof lookup: the default group is identified by the flag, not name
  select p.id into _group_id
  from {{schema}}.principal p
  where p.space_id = _space_id
  and p.is_default_group;

  if _group_id is null then
    -- create_group rosters the group into principal_space; not an admin group;
    -- flagged as the space's default group.
    _group_id := {{schema}}.create_group(_space_id, coalesce(_name, 'team'), false, null, true);
  end if;

  if coalesce(_grant_defaults, true) then
    perform {{schema}}.grant_tree_access(_space_id, _group_id, 'share'::ltree, 1);          -- read
    perform {{schema}}.grant_tree_access(_space_id, _group_id, 'share.projects'::ltree, 2); -- write
  end if;

  return _group_id;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}
