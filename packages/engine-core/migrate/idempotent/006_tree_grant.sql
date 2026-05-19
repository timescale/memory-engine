
-------------------------------------------------------------------------------
-- grant_tree_actions
-------------------------------------------------------------------------------
create or replace function {{schema}}.grant_tree_actions
( _grantor_id uuid
, _actions text[]
, _tree_path ltree
, _user_id uuid
)
returns void
as $func$
begin
  -- is grantor allowed to do this?
  if not {{schema}}.is_tree_owner(_grantor_id, _tree_path) then
    raise exception 'grantor (%) must be a superuser or own the tree path %', _grantor_id, _tree_path
      using errcode = 'insufficient_privilege';
  end if;

  insert into {{schema}}.tree_grant as g
  ( user_id
  , tree_path
  , actions
  )
  values
  ( _user_id
  , _tree_path
  , coalesce(array(select distinct a.action from unnest(_actions) a(action) order by a.action), '{}')
  )
  on conflict (user_id, tree_path) do update
  set actions = coalesce
  (
    array
    (
      select distinct a.action
      from unnest(g.actions || excluded.actions) a(action)
      order by a.action
    )
  , '{}'
  )
  ;
end;
$func$ language plpgsql volatile security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- revoke_tree_actions
-------------------------------------------------------------------------------
create or replace function {{schema}}.revoke_tree_actions
( _revoker_id uuid
, _actions text[]
, _tree_path ltree
, _user_id uuid
)
returns void
as $func$
declare
  _existing_actions text[];
  _remaining_actions text[];
  _remaining_action_count int8;
begin
  -- checking permissions is expensive (relatively)
  -- ensure this operation even makes sense first
  select g.actions into _existing_actions
  from {{schema}}.tree_grant g
  where g.tree_path = _tree_path
  and g.user_id = _user_id
  and g.actions && _actions
  ;
  if not found then
    return;
  end if;

  -- is revoker allowed to do this?
  if not {{schema}}.is_tree_owner(_revoker_id, _tree_path) then
    raise exception 'revoker (%) must be a superuser or own the tree path %', _revoker_id, _tree_path
      using errcode = 'insufficient_privilege';
  end if;

  -- calc remaining actions
  select coalesce(array_agg(x.action order by x.action), '{}'), count(*)
  into strict _remaining_actions, _remaining_action_count
  from
  (
    select unnest(_existing_actions) as action
    except
    select unnest(_actions) as action
  ) x
  ;

  if _remaining_action_count = 0 then
    delete from {{schema}}.tree_grant g
    where g.user_id = _user_id
    and g.tree_path = _tree_path
    ;
  else
    update {{schema}}.tree_grant g
    set actions = _remaining_actions
    where g.user_id = _user_id
    and g.tree_path = _tree_path
    ;
  end if;
end;
$func$ language plpgsql volatile security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
