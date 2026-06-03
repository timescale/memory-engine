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
  -- member's grants via groups
  select
    ta.tree_path
  , ta.access
  from {{schema}}.member_groups(_member_id, _space_id) mg
  inner join {{schema}}.tree_access ta on (mg.group_id = ta.principal_id and ta.space_id = _space_id)
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
  select
    x.tree_path
  , max(x.access)
  from
  (
    -- take the agent's access when it is covered by the owner's access
    select
      aa.tree_path
    , aa.access
    from agent_access aa
    where exists
    (
      -- the owner must have access that is the same or greater than the agent's
      select 1
      from owner_access oa
      where oa.tree_path @> aa.tree_path
      and oa.access >= aa.access
    )
    union
    -- when the agent has more access than the owner, take the owner's access
    select
      oa.tree_path
    , oa.access
    from owner_access oa
    where exists
    (
      select 1
      from agent_access aa
      where aa.tree_path @> oa.tree_path
      and aa.access >= oa.access
    )
  ) x
  group by x.tree_path
$func$ language sql stable security invoker
;

-------------------------------------------------------------------------------
-- build_tree_access
--
-- The bridge from core's access model to the space data-plane functions:
-- resolves a member's (user or agent) effective grants in a space and returns
-- them as the jsonb array shape that space.search_memory / *_memory consume via
-- jsonb_to_recordset(...) x(tree_path ltree, access int).
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
