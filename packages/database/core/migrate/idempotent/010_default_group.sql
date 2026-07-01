-------------------------------------------------------------------------------
-- provision_default_group
-- Creates a space's default "team" group (idempotently) and sets its standard
-- grants: read on `share`, write on `share.projects`. Called in the
-- space-creation transaction (see packages/server/provision.ts addSpaceCreator)
-- so every new space gets the group.
--
-- Delegates group creation to create_group, so the group is rostered into
-- principal_space (the single source of truth for space membership — see
-- TNT-160) as a NON-admin group. The group starts memberless, so its grants are
-- dormant: member_tree_access yields nothing until a member is added, so this
-- changes no member's effective access on its own. It exists so invite/join
-- defaults can later be driven by the group instead of hardcoded in code.
--
-- Existing spaces are backfilled by the one-time incremental migration
-- 012_default_groups.sql, which deliberately inlines the same intent rather than
-- calling this function: incrementals run before idempotents (this file is
-- idempotent), so this function does not yet exist when the backfill runs, and a
-- one-time migration should stay frozen regardless of how this living function
-- later evolves.
--
-- Returns the group id (created or pre-existing). Idempotent: a re-call is a
-- no-op — the group is created only when absent, and grant_tree_access upserts
-- the grants in place.
-------------------------------------------------------------------------------
create or replace function {{schema}}.provision_default_group
( _space_id uuid
)
returns uuid
as $func$
declare
  _group_id uuid;
begin
  select p.id into _group_id
  from {{schema}}.principal p
  where p.space_id = _space_id
  and p.group_id is not null
  and p.name = 'team';

  if _group_id is null then
    -- create_group rosters the group into principal_space; not an admin group
    _group_id := {{schema}}.create_group(_space_id, 'team', false);
  end if;

  perform {{schema}}.grant_tree_access(_space_id, _group_id, 'share'::ltree, 1);          -- read
  perform {{schema}}.grant_tree_access(_space_id, _group_id, 'share.projects'::ltree, 2); -- write

  return _group_id;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
