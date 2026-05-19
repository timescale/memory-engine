-------------------------------------------------------------------------------
-- would_create_cycle
-------------------------------------------------------------------------------
create or replace function {{schema}}.would_create_cycle
( _role_id uuid
, _member_id uuid
)
returns boolean
as $func$
  with recursive ancestors(id) as
  (
    select rm.role_id
    from {{schema}}.role_membership rm
    where rm.member_id = _role_id
    union
    select rm.role_id
    from {{schema}}.role_membership rm
    inner join ancestors a on a.id = rm.member_id
  )
  select _member_id = _role_id
    or exists
    (
      select 1
      from ancestors
      where id = _member_id
    )
$func$ language sql stable security invoker parallel safe
;

-------------------------------------------------------------------------------
-- role_membership_before_write trigger
-------------------------------------------------------------------------------
-- Prevent role membership cycles for ordinary writes.
-- Note: this check observes the current transaction snapshot. Concurrent
-- transactions that insert/update related role edges can still race unless the
-- caller uses stronger locking or serializable transactions around
-- role_membership writes.
create or replace function {{schema}}.role_membership_before_write()
returns trigger
as $func$
begin
  if {{schema}}.would_create_cycle(new.role_id, new.member_id) then
    raise exception 'role membership would create a cycle: role_id %, member_id %', new.role_id, new.member_id
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$func$ language plpgsql volatile security definer
;

create or replace trigger role_membership_before_write_trg
before insert or update of role_id, member_id on {{schema}}.role_membership
for each row
execute function {{schema}}.role_membership_before_write()
;

-------------------------------------------------------------------------------
-- calc_role_membership
-------------------------------------------------------------------------------
create or replace function {{schema}}.calc_role_membership(_user_id uuid)
returns table
( role_id uuid
, superuser bool
, dist int4
)
as $func$
  with recursive ancestors(id, dist) as
  (
    select rm.role_id, 1::int4
    from {{schema}}.role_membership rm
    where rm.member_id = _user_id
    union
    select rm.role_id, a.dist + 1
    from {{schema}}.role_membership rm
    inner join ancestors a on a.id = rm.member_id
  )
  select
    u.id
  , u.superuser
  , 0::int4
  from {{schema}}."user" u
  where u.id = _user_id
  union
  select
    u.id
  , u.superuser
  , a.dist
  from {{schema}}."user" u
  inner join ancestors a on (u.id = a.id)
$func$ language sql stable security invoker
;

-------------------------------------------------------------------------------
-- is_superuser
-------------------------------------------------------------------------------
create or replace function {{schema}}.is_superuser(_user_id uuid)
returns boolean
as $func$
  select exists
  (
    select 1
    from {{schema}}.calc_role_membership(_user_id) x
    where x.superuser
  )
$func$ language sql stable security definer
set search_path to pg_catalog, {{schema}}, pg_temp
;

-------------------------------------------------------------------------------
-- grant_role_membership
-------------------------------------------------------------------------------
create or replace function {{schema}}.grant_role_membership
( _grantor_id uuid
, _role_id uuid
, _member_id uuid
, _with_admin_option bool default false
)
returns void
as $func$
declare
  _allowed bool;
begin
  -- exclusive write access required to fully ensure against cycle creation by concurrent writes
  lock table {{schema}}.role_membership in share row exclusive mode;

  -- is grantor allowed to do this?
  select
    exists
    (
      -- does the grantor have with admin privilege directly on this role?
      select 1
      from {{schema}}.role_membership rm
      where rm.role_id = _role_id
      and rm.member_id = _grantor_id
      and rm.with_admin_option
    )
    or {{schema}}.is_superuser(_grantor_id) -- or are they a superuser (even indirectly)?
  into strict _allowed
  ;

  if not _allowed then
    raise exception 'grantor must be a superuser or have with admin option on role: grantor_id % role_id %', _grantor_id, _role_id
      using errcode = 'insufficient_privilege';
  end if;

  -- role_membership_before_write_trg protects against cycles in the graph
  insert into {{schema}}.role_membership
  ( role_id
  , member_id
  , with_admin_option
  )
  values
  ( _role_id
  , _member_id
  , _with_admin_option
  )
  on conflict (member_id, role_id)
  do update set with_admin_option = _with_admin_option
  ;
end;
$func$ language plpgsql volatile security definer
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
  lock table {{schema}}.role_membership in share row exclusive mode;

  -- is revoker allowed to do this?
  select
    exists
    (
      -- does the revoker have with admin privilege directly on this role?
      select 1
      from {{schema}}.role_membership rm
      where rm.role_id = _role_id
      and rm.member_id = _revoker_id
      and rm.with_admin_option
    )
    or {{schema}}.is_superuser(_revoker_id) -- or are they a superuser (even indirectly)?
  into strict _allowed
  ;

  if not _allowed then
    raise exception 'revoker must be a superuser or have with admin option on role: revoker_id % role_id %', _revoker_id, _role_id
      using errcode = 'insufficient_privilege';
  end if;

  delete from {{schema}}.role_membership d
  where d.role_id = _role_id
  and d.member_id = _member_id
  ;
end;
$func$ language plpgsql volatile security definer
set search_path to pg_catalog, {{schema}}, pg_temp
;
