
-------------------------------------------------------------------------------
-- member_groups
-------------------------------------------------------------------------------
create or replace function {{schema}}.member_groups
( _member_id uuid
, _space_id uuid
)
returns table
( group_id uuid
, admin bool
)
as $func$
  -- Group membership is space-scoped by group_member.space_id. It does NOT by
  -- itself confer space access: a member's group grants are effective only if
  -- the member is also a direct space member (gated in member_tree_access), so a
  -- member can be pre-staged into a group before joining the space. This just
  -- lists the member's groups; the FKs constrain group_id to a group and
  -- member_id to a user/agent.
  select
    gm.group_id
  , gm.admin and (not m.kind = 'a') -- agents cannot be group admins
  from {{schema}}.group_member gm
  inner join {{schema}}.principal m on (m.member_id = gm.member_id)
  where gm.member_id = _member_id
  and gm.space_id = _space_id
$func$ language sql stable security invoker
;

-------------------------------------------------------------------------------
-- is_group_admin
-- Whether a member is an admin of a specific group in a space. (Agents are
-- never group admins — enforced by member_groups.)
-------------------------------------------------------------------------------
create or replace function {{schema}}.is_group_admin
( _member_id uuid
, _group_id uuid
, _space_id uuid
)
returns bool
as $func$
  select exists
  (
    select 1
    from {{schema}}.member_groups(_member_id, _space_id) mg
    where mg.group_id = _group_id
    and mg.admin
  )
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
