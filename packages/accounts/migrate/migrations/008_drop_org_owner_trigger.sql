-- Remove the "must keep at least one owner" trigger on org_member.
--
-- The trigger fired before any DELETE or UPDATE on org_member, including
-- the rows cascaded by `delete from org` (since org_member.org_id has
-- `references org on delete cascade`). When an org was being deleted in
-- its entirety, the cascade removed the org's owner row too, and the
-- trigger refused — making it impossible to delete an org that you owned.
--
-- The invariant is now enforced at the application layer in
-- packages/accounts/ops/org-member.ts (removeMember + updateRole), where
-- it can distinguish member-management flows from a cascading org delete.
drop trigger if exists org_member_owner_check on {{schema}}.org_member;
drop function if exists {{schema}}.check_org_has_owner();
