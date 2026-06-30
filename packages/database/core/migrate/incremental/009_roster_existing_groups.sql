-- One-time backfill: roster pre-existing groups into principal_space.
--
-- create_group now rosters a group on creation (principal_space is the single
-- source of truth for who/what belongs to a space — see TNT-160), but any group
-- created before that change has only a `principal` row and no roster entry, so
-- it is invisible to principal.resolve / list_space_principals and cannot be
-- granted/referenced by name. Insert the missing roster rows.
--
-- Done as a direct insert (not add_principal_to_space) because incremental
-- migrations run before the idempotent function definitions. admin=false: a
-- backfilled group is not retroactively an admin group. Groups get no home grant.
-- Idempotent via the unique(principal_id, space_id) conflict — a no-op on a fresh
-- schema (no groups yet) and on any database already rostering its groups.
insert into {{schema}}.principal_space (space_id, principal_id, admin)
select p.space_id, p.id, false
from {{schema}}.principal p
where p.kind = 'g'
and p.space_id is not null
on conflict (principal_id, space_id) do nothing;
