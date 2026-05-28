-------------------------------------------------------------------------------
-- member_tree_access
-------------------------------------------------------------------------------
create or replace function core.member_tree_access
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
  from core.member_groups(_member_id, _space_id) mg
  inner join core.tree_access ta on (mg.group_id = ta.principal_id and ta.space_id = _space_id)
$func$ language sql stable security invoker
;

-------------------------------------------------------------------------------
-- user_tree_access
-------------------------------------------------------------------------------
create or replace function core.user_tree_access
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
  from core.principal u
  inner join core.principal_space psu on (u.id = psu.principal_id and psu.space_id = _space_id)
  inner join core.tree_access ta on (u.id = ta.principal_id and ta.space_id = _space_id)
  where u.user_id = _user_id
  union
  -- user's access via groups
  select
    x.tree_path
  , x.access
  from core.member_tree_access(_user_id, _space_id) x
$func$ language sql stable security invoker
;

-------------------------------------------------------------------------------
-- agent_tree_access
-------------------------------------------------------------------------------
create or replace function core.agent_tree_access
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
    from core.principal a
    inner join core.principal_space ps on (a.id = ps.principal_id and ps.space_id = _space_id)
    inner join core.tree_access ta on (a.id = ta.principal_id and ta.space_id = _space_id)
    where a.agent_id = _agent_id
    union
    -- agent's access via groups
    select
      x.tree_path
    , x.access
    from core.member_tree_access(_agent_id, _space_id) x
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
      from core.principal p
      where p.agent_id = _agent_id
    ) a
    cross join lateral core.user_tree_access(a.owner_id, _space_id) x
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
