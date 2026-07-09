-------------------------------------------------------------------------------
-- member_tree_access
-------------------------------------------------------------------------------
create or replace function {{schema}}.member_tree_access
( _member_id uuid
, _space_id uuid
)
returns table
( tree_path ltree
, access int
)
as $func$
  -- A member's grants via groups apply only if the member is ALSO a direct
  -- member of the space (a principal_space row). Group membership alone never
  -- confers space access — joining the space is the single membership path — so
  -- a group_member row for a non-member yields nothing here (the group's grants
  -- stay dormant until the member joins). Endpoint admission is checked against
  -- principal_space separately; this function only computes data access.
  select
    ta.tree_path
  , ta.access
  from {{schema}}.member_groups(_member_id, _space_id) mg
  inner join {{schema}}.tree_access ta on (mg.group_id = ta.principal_id and ta.space_id = _space_id)
  where {{schema}}.is_principal_in_space(_member_id, _space_id)
$func$ language sql stable security invoker
;

-------------------------------------------------------------------------------
-- user_tree_access
-------------------------------------------------------------------------------
create or replace function {{schema}}.user_tree_access
( _user_id uuid
, _space_id uuid
)
returns table
( tree_path ltree
, access int
)
as $func$
  -- user's direct grants
  select
    ta.tree_path
  , ta.access
  from {{schema}}.principal u
  inner join {{schema}}.principal_space psu on (u.id = psu.principal_id and psu.space_id = _space_id)
  inner join {{schema}}.tree_access ta on (u.id = ta.principal_id and ta.space_id = _space_id)
  where u.user_id = _user_id
  union
  -- user's access via groups
  select
    x.tree_path
  , x.access
  from {{schema}}.member_tree_access(_user_id, _space_id) x
$func$ language sql stable security invoker
;

-------------------------------------------------------------------------------
-- service_account_tree_access
-------------------------------------------------------------------------------
create or replace function {{schema}}.service_account_tree_access
( _service_account_id uuid
, _space_id uuid
)
returns table
( tree_path ltree
, access int
)
as $func$
  -- Service accounts are top-level space-scoped members: their effective access
  -- is their direct grants plus grants inherited from ordinary groups they belong
  -- to. Unlike agents, there is no owner clamp.
  select
    ta.tree_path
  , ta.access
  from {{schema}}.principal s
  inner join {{schema}}.principal_space ps on (s.id = ps.principal_id and ps.space_id = _space_id)
  inner join {{schema}}.tree_access ta on (s.id = ta.principal_id and ta.space_id = _space_id)
  where s.kind = 's'
  and s.id = _service_account_id
  union
  select
    x.tree_path
  , x.access
  from {{schema}}.member_tree_access(_service_account_id, _space_id) x
$func$ language sql stable security invoker
;

-------------------------------------------------------------------------------
-- agent_tree_access
-------------------------------------------------------------------------------
create or replace function {{schema}}.agent_tree_access
( _agent_id uuid
, _space_id uuid
)
returns table
( tree_path ltree
, access int
)
as $func$
  with agent_access as materialized
  (
    -- agent's direct grants
    select
      ta.tree_path
    , ta.access
    from {{schema}}.principal a
    inner join {{schema}}.principal_space ps on (a.id = ps.principal_id and ps.space_id = _space_id)
    inner join {{schema}}.tree_access ta on (a.id = ta.principal_id and ta.space_id = _space_id)
    where a.agent_id = _agent_id
    union
    -- agent's access via groups
    select
      x.tree_path
    , x.access
    from {{schema}}.member_tree_access(_agent_id, _space_id) x
  )
  , owner_access as materialized
  (
    -- get the access for the user that owns the agent
    select
      x.tree_path
    , x.access
    from
    (
      select p.owner_id
      from {{schema}}.principal p
      where p.agent_id = _agent_id
    ) a
    cross join lateral {{schema}}.user_tree_access(a.owner_id, _space_id) x
  )
  -- An agent's effective access is its grants clamped to its owner's: at every
  -- path on a shared lineage the agent gets least(agent, owner). So it can never
  -- exceed the owner — and, when granted MORE than the owner holds, it clamps
  -- DOWN to the owner's level rather than vanishing (e.g. owner read@foo + agent
  -- write@foo.bar -> the agent gets read@foo.bar). Two arms cover the two nesting
  -- directions; the deeper path wins each pairing, and max() collapses duplicate
  -- paths to the highest surviving level. A path the owner doesn't cover at all
  -- produces no row, so the agent gets nothing there.
  select
    x.tree_path
  , max(x.access)
  from
  (
    -- owner grant is at-or-above the agent's path: clamp the agent's grant down
    select
      aa.tree_path
    , least(aa.access, oa.access) as access
    from agent_access aa
    inner join owner_access oa on (oa.tree_path @> aa.tree_path)
    union all
    -- agent grant is at-or-above the owner's (narrower) path: take min at the owner's
    select
      oa.tree_path
    , least(aa.access, oa.access) as access
    from agent_access aa
    inner join owner_access oa on (aa.tree_path @> oa.tree_path)
  ) x
  group by x.tree_path
$func$ language sql stable security invoker
;

-------------------------------------------------------------------------------
-- build_tree_access
--
-- The bridge from core's access model to the space data-plane functions:
  -- resolves a member's (user, agent, or service account) effective grants in a
  -- space and returns them as the jsonb array shape that space.search_memory /
  -- *_memory consume via jsonb_to_recordset(...) x(tree_path ltree, access int).
-------------------------------------------------------------------------------
create or replace function {{schema}}.build_tree_access
( _member_id uuid
, _space_id uuid
)
returns jsonb
as $func$
  with access as
  (
    select ta.tree_path, ta.access
    from {{schema}}.principal p
    cross join lateral
    (
      -- dispatch on kind; the off-kind branch's id column is null -> no rows
      select uta.tree_path, uta.access
      from {{schema}}.user_tree_access(p.user_id, _space_id) uta
      where p.kind = 'u'
      union all
      select ata.tree_path, ata.access
      from {{schema}}.agent_tree_access(p.agent_id, _space_id) ata
      where p.kind = 'a'
      union all
      select sta.tree_path, sta.access
      from {{schema}}.service_account_tree_access(p.id, _space_id) sta
      where p.kind = 's'
    ) ta
    where p.member_id = _member_id
  )
  select coalesce
  (
    jsonb_agg(jsonb_build_object('tree_path', a.tree_path::text, 'access', a.access))
  , '[]'::jsonb
  )
  from access a
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
