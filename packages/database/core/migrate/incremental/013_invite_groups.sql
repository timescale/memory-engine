-------------------------------------------------------------------------------
-- Invitations target one or more GROUPS (default "team"), not a hardcoded share
-- level.
--
-- An invitation carries the groups its redeemer is added to (see
-- idempotent/009_invitation.sql _join_via_invitation); each group's grants
-- (read@share + write@share.projects for "team") replace the old per-invite
-- share_access default grant. group_ids is a NOT NULL, non-empty uuid[] — every
-- invite has at least one group.
--
-- A uuid[] cannot carry a foreign key, so the "each element is a group in this
-- space" invariant is enforced by the enforce_invitation_groups_coherence
-- constraint trigger (idempotent/009_invitation.sql) instead of an FK.
--
-- Backfill safety: 012_default_groups.sql ran earlier in this same migration
-- transaction and gave every space a "team" group, so every existing invitation
-- can be pointed at one before the NOT NULL is set. Fresh schemas have no
-- invitations, so the backfill is a no-op.
-------------------------------------------------------------------------------
alter table {{schema}}.space_invitation
  add column group_ids uuid[];

-- point every existing invitation at its space's "team" group
update {{schema}}.space_invitation si
set group_ids = array[p.id]
from {{schema}}.principal p
where p.space_id = si.space_id
and p.group_id is not null
and p.name = 'team';

alter table {{schema}}.space_invitation
  alter column group_ids set not null;

-- non-empty, no null elements; the trigger checks each element is an in-space group
alter table {{schema}}.space_invitation
  add constraint space_invitation_group_ids_valid
  check (cardinality(group_ids) >= 1 and array_position(group_ids, null) is null);

-- the per-invite share grant is gone; access now flows from the target groups
alter table {{schema}}.space_invitation
  drop column share_access;
