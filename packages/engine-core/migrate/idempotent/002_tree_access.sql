-------------------------------------------------------------------------------
-- calc_tree_access
-------------------------------------------------------------------------------
create or replace function {{schema}}.calc_tree_access(_user_id uuid)
returns table
( role_id uuid
, tree_path ltree
, access int2
)
as $func$
  with r as
  (
    -- the user and the roles they belong to
    select
      x.role_id
    , x.superuser
    from {{schema}}.calc_role_membership(_user_id) x
  )
  -- superuser
  select
    r.role_id
  , ''::ltree as tree_path
  , 3::int2 /* owner */ as access
  from r
  where r.superuser
  union all
  -- grants
  select
    r.role_id
  , a.tree_path
  , a.access::int2
  from r
  inner join {{schema}}.tree_access a on (r.role_id = a.user_id)
$func$ language sql stable security invoker
;

-------------------------------------------------------------------------------
-- has_tree_access
-------------------------------------------------------------------------------
create or replace function {{schema}}.has_tree_access
( _user_id uuid
, _tree_path ltree
, _access int4
)
returns bool
as $func$
  select exists
  (
    select 1
    from {{schema}}.calc_tree_access(_user_id) x
    where x.tree_path @> _tree_path
    and x.access >= _access
    and _access in (1, 2, 3)
  )
$func$ language sql stable security invoker
;
