
-------------------------------------------------------------------------------
-- is_tree_owner
-------------------------------------------------------------------------------
create or replace function {{schema}}.is_tree_owner
( _user_id uuid
, _tree_path ltree
)
returns bool
as $func$
  with r as
  (
    select *
    from {{schema}}.calc_role_membership(_user_id)
  )
  select
    exists (select 1 from r where r.superuser) -- is user a superuser?
    or exists
    (
      -- does user own the path?
      select 1
      from r
      inner join {{schema}}.tree_owner o on (r.role_id = o.user_id)
      where o.tree_path @> _tree_path
    )
$func$ language sql volatile security invoker parallel safe
;

-------------------------------------------------------------------------------
-- grant_tree_ownership
-------------------------------------------------------------------------------
create or replace function {{schema}}.grant_tree_ownership
( _grantor_id uuid
, _tree_path ltree
, _owner_id uuid
)
returns void
as $func$
begin
  -- is grantor allowed to do this?
  if not {{schema}}.is_tree_owner(_grantor_id, _tree_path) then
    raise exception 'grantor (%) must be a superuser or own the tree path %', _grantor_id, _tree_path
      using errcode = 'insufficient_privilege';
  end if;

  insert into {{schema}}.tree_owner
  ( tree_path
  , user_id
  )
  values
  ( _tree_path
  , _owner_id
  )
  on conflict (tree_path) do update
  set user_id = _owner_id
  ;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- revoke_tree_ownership
-------------------------------------------------------------------------------
create or replace function {{schema}}.revoke_tree_ownership
( _revoker_id uuid
, _tree_path ltree
, _owner_id uuid
)
returns void
as $func$
begin
  -- checking permissions is expensive (relatively)
  -- ensure this operation even makes sense first
  perform 1
  from {{schema}}.tree_owner o
  where o.tree_path = _tree_path
  and o.user_id = _owner_id
  ;
  if not found then
    return;
  end if;

  -- is revoker allowed to do this?
  if not {{schema}}.is_tree_owner(_revoker_id, _tree_path) then
    raise exception 'revoker (%) must be a superuser or own the tree path %', _revoker_id, _tree_path
      using errcode = 'insufficient_privilege';
  end if;

  delete from {{schema}}.tree_owner
  where tree_path = _tree_path
  and user_id = _owner_id
  ;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
