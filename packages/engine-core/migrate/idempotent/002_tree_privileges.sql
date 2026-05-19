-------------------------------------------------------------------------------
-- calc_tree_privileges
-------------------------------------------------------------------------------
create or replace function {{schema}}.calc_tree_privileges(_user_id uuid)
returns table
( role_id uuid
, tree_path ltree
, actions text[]
, reason text
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
  , array['read', 'create', 'update', 'delete'] as actions
  , 'superuser' as reason
  from r
  where r.superuser
  union all
  -- ownership
  select
    r.role_id
  , o.tree_path
  , array['read', 'create', 'update', 'delete'] as actions
  , 'owner' as reason
  from r
  inner join {{schema}}.tree_owner o on (r.role_id = o.user_id)
  union all
  -- grants
  select
    r.role_id
  , g.tree_path
  , g.actions
  , 'grant' as reason
  from r
  inner join {{schema}}.tree_grant g on (r.role_id = g.user_id)
$func$ language sql stable security invoker
;

-------------------------------------------------------------------------------
-- has_tree_privilege
-------------------------------------------------------------------------------
create or replace function {{schema}}.has_tree_privilege
( _user_id uuid
, _tree_path ltree
, _actions text[]
)
returns bool
as $func$
  select exists
  (
    select 1
    from {{schema}}.calc_tree_privileges(_user_id) x
    where x.tree_path @> _tree_path
    and x.actions @> _actions
  )
$func$ language sql stable security invoker
;
