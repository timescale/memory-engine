-------------------------------------------------------------------------------
-- Invitations target a GROUP (default "team"), not a hardcoded share level.
--
-- An invitation now carries the group its redeemer is added to (see
-- idempotent/009_invitation.sql _join_via_invitation → add_group_member); the
-- group's grants (read@share + write@share.projects for "team") replace the old
-- per-invite share_access default grant. group_id is NOT NULL — every invite
-- has a group.
--
-- The composite (group_id, space_id) FK into principal(group_id, space_id) (the
-- unique key from 011_group_member_space_fk.sql) does double duty:
-- principal.group_id is non-null only for kind='g', so the target can only be a
-- GROUP, and it must live in the invite's own space. No trigger needed.
--
-- Backfill safety: 012_default_groups.sql ran earlier in this same migration
-- transaction and gave every space a "team" group, so every existing invitation
-- can be pointed at one before the NOT NULL is set. Fresh schemas have no
-- invitations, so the backfill is a no-op.
-------------------------------------------------------------------------------
alter table {{schema}}.space_invitation
  add column group_id uuid;

-- point every existing invitation at its space's "team" group
update {{schema}}.space_invitation si
set group_id = p.id
from {{schema}}.principal p
where p.space_id = si.space_id
and p.group_id is not null
and p.name = 'team';

alter table {{schema}}.space_invitation
  alter column group_id set not null;

-- (group_id, space_id) -> principal: target is necessarily a group in this space
alter table {{schema}}.space_invitation
  add constraint space_invitation_group_id_space_id_fkey
  foreign key (group_id, space_id)
  references {{schema}}.principal (group_id, space_id)
  on delete cascade;

-- the per-invite share grant is gone; access now flows from the target group
alter table {{schema}}.space_invitation
  drop column share_access;
