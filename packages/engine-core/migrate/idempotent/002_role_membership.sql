-------------------------------------------------------------------------------
-- has_user_admin
-------------------------------------------------------------------------------
create or replace function {{schema}}.has_user_admin(_actor_id uuid)
returns boolean
as $func$
  select exists
  (
    select 1
    from {{schema}}.role_membership r
    where r.member_id = _actor_id
    and r.role_id = '00584580-f000-7000-8000-000000000001'
  )
$func$ language sql stable security invoker
;

-------------------------------------------------------------------------------
-- has_tree_admin
-------------------------------------------------------------------------------
create or replace function {{schema}}.has_tree_admin(_actor_id uuid)
returns boolean
as $func$
  select exists
  (
    select 1
    from {{schema}}.role_membership r
    where r.member_id = _actor_id
    and r.role_id = '00584580-f000-7000-8000-000000000002'
  )
$func$ language sql stable security invoker
;

-------------------------------------------------------------------------------
-- grant_role_membership
-------------------------------------------------------------------------------
create or replace function {{schema}}.grant_role_membership
( _grantor_id uuid
, _role_id uuid
, _member_id uuid
, _admin bool default false
)
returns void
as $func$
declare
  _allowed bool;
  _has_admin bool;
begin
  -- is grantor allowed to do this?
  select
    exists
    (
      -- does the grantor have with admin privilege directly on this role?
      select 1
      from {{schema}}.role_membership r
      where r.role_id = _role_id
      and r.member_id = _grantor_id
      and r.admin
    )
    or {{schema}}.has_user_admin(_grantor_id) -- or are they a user-admin?
  into strict _allowed
  ;

  if not _allowed then
    -- is grantor a member of the role, and member their delegate?
    select r.admin into _has_admin
    from {{schema}}.actor o
    inner join {{schema}}.actor d on (o.user_id = d.owner_id)
    inner join {{schema}}.role_membership r on (o.member_id = r.member_id)
    where r.role_id = _role_id
    and o.user_id = _grantor_id
    and d.user_id = _member_id
    ;

  end if;

  if not _allowed then
    raise exception 'not allowed'
      using errcode = 'insufficient_privilege';
  end if;

  insert into {{schema}}.role_membership
  ( role_id
  , member_id
  , admin
  )
  values
  ( _role_id
  , _member_id
  , _admin
  )
  on conflict (member_id, role_id)
  do update set admin = _admin
  ;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, pg_temp
;

-------------------------------------------------------------------------------
-- revoke_role_membership
-------------------------------------------------------------------------------
create or replace function {{schema}}.revoke_role_membership
( _revoker_id uuid
, _role_id uuid
, _member_id uuid
)
returns void
as $func$
declare
  _allowed bool;
begin
  -- is revoker allowed to do this?
  select
    exists
    (
      -- does the revoker have with admin privilege directly on this role?
      select 1
      from {{schema}}.role_membership rm
      where rm.role_id = _role_id
      and rm.member_id = _revoker_id
      and rm.admin
    )
    or {{schema}}.has_user_admin(_revoker_id) -- or are they a user-admin?
  into strict _allowed
  ;

  if not _allowed then
    raise exception 'revoker not allowed to administer role'
      using errcode = 'insufficient_privilege';
  end if;

  delete from {{schema}}.role_membership d
  where d.role_id = _role_id
  and d.member_id = _member_id
  ;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, pg_temp
;
