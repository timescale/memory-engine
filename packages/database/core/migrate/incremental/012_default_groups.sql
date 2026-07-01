-------------------------------------------------------------------------------
-- Backfill the default "team" group for every existing space.
--
-- One-time data migration (incremental: runs once, tracked in
-- {{schema}}.migration). Mirrors the living provision_default_group() but is
-- intentionally inlined and set-based: incrementals run before idempotents, so
-- provision_default_group() (and create_group) do not yet exist when this runs,
-- and a one-time migration should stay frozen regardless of how those functions
-- later evolve. Pure core-schema work (principal + principal_space +
-- tree_access), so it never touches the per-space me_<slug> data schemas.
--
-- Each created group is rostered into principal_space (the source of truth for
-- space membership — see TNT-160 and 010_roster_existing_groups.sql) as a
-- NON-admin group, and granted read@share + write@share.projects. Done as direct
-- inserts (not create_group / add_principal_to_space) for the same
-- ordering reason.
--
-- Conservative and non-clobbering: it creates a "team" group only for spaces
-- that lack one, and rosters/grants only the groups it just created. A
-- pre-existing "team" group (its roster row and grants) is left untouched.
-------------------------------------------------------------------------------
with created as
(
  insert into {{schema}}.principal (kind, name, space_id)
  select 'g', 'team', s.id
  from {{schema}}.space s
  where not exists
  (
    select 1
    from {{schema}}.principal p
    where p.space_id = s.id
    and p.group_id is not null
    and p.name = 'team'
  )
  returning id, space_id
)
, rostered as
(
  insert into {{schema}}.principal_space (space_id, principal_id, admin)
  select space_id, id, false from created
  on conflict (principal_id, space_id) do nothing
)
insert into {{schema}}.tree_access (space_id, principal_id, tree_path, access)
select space_id, id, 'share'::ltree, 1 from created          -- read on share
union all
select space_id, id, 'share.projects'::ltree, 2 from created -- write on share.projects
;
