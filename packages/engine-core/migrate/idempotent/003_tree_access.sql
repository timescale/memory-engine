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
  select
    r.role_id
  , a.tree_path
  , a.access::int2
  from {{schema}}.calc_role_membership(_user_id) r
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

-------------------------------------------------------------------------------
-- set_tree_access
-------------------------------------------------------------------------------
create or replace function {{schema}}.set_tree_access
( _grantor_id uuid
, _tree_path ltree
, _user_id uuid
, _access int4
)
returns bool
as $func$
begin
  -- grantor must be superuser or owner of tree
  if not {{schema}}.has_tree_access(_grantor_id, _tree_path, 3) then
    raise exception 'insufficient tree access'
      using errcode = 'insufficient_privilege';
  end if;

  insert into {{schema}}.tree_access
  ( user_id
  , tree_path
  , access
  )
  values
  ( _user_id
  , _tree_path
  , _access::int2
  )
  on conflict (user_id, tree_path) do update
  set access = _access::int2
  ;

  return found;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- remove_all_tree_access
-------------------------------------------------------------------------------
create or replace function {{schema}}.remove_all_tree_access
( _grantor_id uuid
, _tree_path ltree
, _user_id uuid
)
returns bool
as $func$
begin
  -- grantor must be superuser or owner of tree
  if not {{schema}}.has_tree_access(_grantor_id, _tree_path, 3) then
    raise exception 'insufficient tree access'
      using errcode = 'insufficient_privilege';
  end if;

  delete from {{schema}}.tree_access
  where user_id = _user_id
  and _tree_path @> tree_path
  ;

  return found;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- list_tree_access
-------------------------------------------------------------------------------
create or replace function {{schema}}.list_tree_access
( _requestor_id uuid
, _tree_path ltree
)
returns table
( tree_path ltree
, user_id uuid
, access int2
)
as $func$
begin
  -- grantor must be superuser or owner of tree
  if not {{schema}}.has_tree_access(_requestor_id, _tree_path, 3) then
    raise exception 'insufficient tree access'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    a.tree_path
  , a.user_id
  , a.access
  from {{schema}}.tree_access a
  where _tree_path @> a.tree_path
  order by a.tree_path, a.user_id
  ;
end;
$func$ language plpgsql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
