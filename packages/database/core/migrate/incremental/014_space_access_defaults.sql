-------------------------------------------------------------------------------
-- Custom spaces: per-space access defaults.
--
-- Two schema changes plus a one-time backfill:
--
--   1. space.auto_grant_home — when false, the join chokepoint
--      (add_principal_to_space) does NOT seed a joining user/agent's owner@~.
--      Defaults true, so every existing space keeps today's behavior.
--
--   2. principal.is_default_group — marks a space's default/invite group (the
--      one me space invite targets by default and whose grants a joiner inherits).
--      Stored on the group itself (not a space -> principal FK) to avoid a
--      circular FK with principal.space_id -> space.id; it is rename- and
--      delete-robust (the flag dies with the group). A partial-unique index
--      enforces at most one default group per space.
--
-- Backfill: flag every existing space's "team" group as the default so the
-- flag-based invite-default resolution keeps working for pre-existing spaces
-- (each space has exactly one "team" group, so this is one row per space and
-- cannot violate the partial-unique index). The frozen 012/013 incrementals
-- stay untouched.
-------------------------------------------------------------------------------

alter table {{schema}}.space
  add column auto_grant_home boolean not null default true;

alter table {{schema}}.principal
  add column is_default_group boolean not null default false
  -- only a group can be a space's default group (users/agents never are); this
  -- also backstops the partial-unique index below: non-group principals have a
  -- null space_id, which a unique index treats as distinct, so restricting the
  -- flag to groups keeps "one default group per space" airtight.
, add constraint principal_default_group_is_group_check
    check (kind = 'g' or is_default_group is false)
;

-- at most one default group per space (only groups have space_id + is_default_group)
create unique index principal_one_default_group
  on {{schema}}.principal (space_id) where is_default_group;

-- backfill: the existing "team" group becomes each space's default group
update {{schema}}.principal
set is_default_group = true
where group_id is not null
and name = 'team';
