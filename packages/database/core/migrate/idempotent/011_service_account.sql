-------------------------------------------------------------------------------
-- service_account_for_admin_group
-- Returns the service-account id bound to an admin group, or null for an
-- ordinary group.
-------------------------------------------------------------------------------
create or replace function {{schema}}.service_account_for_admin_group
( _group_id uuid
)
returns uuid
as $func$
  select p.id
  from {{schema}}.principal p
  where p.kind = 's'
  and p.admin_id = _group_id
$func$ language sql stable strict security invoker
;

comment on column {{schema}}.principal.admin_id is
  'For service accounts (kind=s), points at the bound admin group via principal(group_id).';

-------------------------------------------------------------------------------
-- create_service_account
-- Creates a service account plus its bound admin group atomically.
-- The service account is rostered into the space with no tree grants and is not
-- added to the default group. _group_admin_member_ids is a subset-or-extension of
-- _member_ids: ids present there are inserted with group_member.admin=true.
-- Initial bound-admin-group members may be users, agents, or service accounts;
-- only direct user members are service-account admins (is_service_account_admin).
-------------------------------------------------------------------------------
create or replace function {{schema}}.create_service_account
( _space_id uuid
, _name text
, _member_ids uuid[] default '{}'::uuid[]
, _group_admin_member_ids uuid[] default '{}'::uuid[]
, _id uuid default null
, _admin_group_id uuid default null
)
returns table
( id uuid
, admin_id uuid
)
as $func$
declare
  _service_id uuid;
  _admin_name text;
begin
  _admin_name := left(_name, 94) || '-admin';

  begin
    select {{schema}}.create_group
    ( _space_id
    , _admin_name
    , false
    , _admin_group_id
    , false
    ) into _admin_group_id;
  exception when unique_violation then
    if exists
    (
      select 1
      from {{schema}}.principal p
      where p.space_id = _space_id
      and p.name = _admin_name::citext
      and p.kind in ('g', 's')
    ) then
      raise exception
        'cannot create service account %: derived admin group name % already exists in this space', _name, _admin_name
        using errcode = '23505'
        , hint = 'choose a service-account name with a different first 94 characters, or rename the conflicting group/service account';
    end if;

    raise;
  end;

  insert into {{schema}}.principal as p (id, kind, name, space_id, admin_id)
  values (coalesce(_id, uuidv7()), 's', _name, _space_id, _admin_group_id)
  returning p.id into _service_id;

  perform {{schema}}.add_principal_to_space(_space_id, _service_id, false);

  insert into {{schema}}.group_member (space_id, group_id, member_id, admin)
  select _space_id, _admin_group_id, initial.member_id
       , initial.member_id = any(coalesce(_group_admin_member_ids, '{}'::uuid[]))
  from
  (
    select distinct member_id
    from unnest
    (
      coalesce(_member_ids, '{}'::uuid[])
      || coalesce(_group_admin_member_ids, '{}'::uuid[])
    ) as members(member_id)
  ) initial
  on conflict (space_id, member_id, group_id) do update set
    admin = excluded.admin;

  return query select _service_id, _admin_group_id;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- get_service_account
-------------------------------------------------------------------------------
create or replace function {{schema}}.get_service_account
( _id uuid
)
returns table
( id uuid
, name text
, admin_id uuid
, space_id uuid
, created_at timestamptz
, updated_at timestamptz
)
as $func$
  select p.id, p.name::text, p.admin_id, p.space_id, p.created_at, p.updated_at
  from {{schema}}.principal p
  where p.kind = 's'
  and p.id = _id
$func$ language sql stable strict rows 1 security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- list_service_accounts
-------------------------------------------------------------------------------
create or replace function {{schema}}.list_service_accounts
( _space_id uuid
)
returns table
( id uuid
, name text
, admin_id uuid
, space_id uuid
, created_at timestamptz
, updated_at timestamptz
)
as $func$
  select p.id, p.name::text, p.admin_id, p.space_id, p.created_at, p.updated_at
  from {{schema}}.principal p
  where p.kind = 's'
  and p.space_id = _space_id
  order by p.name
$func$ language sql stable strict security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- is_service_account_admin
-- A user administers an SA when they are a direct member of the SA's space and a
-- member of its bound admin group. Space-admin override is checked separately by
-- callers via is_principal_space_admin.
-------------------------------------------------------------------------------
create or replace function {{schema}}.is_service_account_admin
( _service_account_id uuid
, _user_id uuid
)
returns bool
as $func$
  select exists
  (
    select 1
    from {{schema}}.principal s
    join {{schema}}.group_member gm
      on gm.space_id = s.space_id
     and gm.group_id = s.admin_id
     and gm.member_id = _user_id
    join {{schema}}.principal u
      on u.user_id = gm.member_id
    join {{schema}}.principal_space ups
      on ups.space_id = s.space_id
     and ups.principal_id = u.id
    where s.kind = 's'
    and s.id = _service_account_id
  )
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- _enforce_service_account_principal_invariants
-- Table-level backstop for bound admin groups:
--   * a service account's admin group must belong to the same space;
--   * it cannot be the default group;
--   * it cannot already be a space-admin group;
--   * it cannot be deleted directly while its service account still exists.
-------------------------------------------------------------------------------
create or replace function {{schema}}._enforce_service_account_principal_invariants()
returns trigger
as $func$
begin
  if tg_op = 'DELETE' then
    if old.kind = 'g'
      and exists (select 1 from {{schema}}.space s where s.id = old.space_id)
      and {{schema}}.service_account_for_admin_group(old.id) is not null
    then
      raise exception
        'cannot delete service-account admin group % directly', old.id
        using errcode = '23514'
        , hint = 'delete the owning service account instead';
    end if;

    return old;
  end if;

  if new.kind = 's' then
    if not exists
    (
      select 1
      from {{schema}}.principal g
      where g.group_id = new.admin_id
      and g.space_id = new.space_id
      and not g.is_default_group
    ) then
      raise exception
        'service account % must reference a non-default admin group in the same space', new.id
        using errcode = '23514';
    end if;

    if exists
    (
      select 1
      from {{schema}}.principal_space ps
      where ps.principal_id = new.admin_id
      and ps.space_id = new.space_id
      and ps.admin
    ) then
      raise exception
        'service-account admin group % cannot be a space-admin group', new.admin_id
        using errcode = '23514';
    end if;
  end if;

  if new.kind = 'g'
    and new.is_default_group
    and {{schema}}.service_account_for_admin_group(new.id) is not null
  then
    raise exception
      'service-account admin group % cannot be the default group', new.id
      using errcode = '23514';
  end if;

  return new;
end;
$func$ language plpgsql
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- _delete_service_account_admin_group
-- Direct table-delete backstop: deleting an SA deletes its bound admin group.
-------------------------------------------------------------------------------
create or replace function {{schema}}._delete_service_account_admin_group()
returns trigger
as $func$
begin
  delete from {{schema}}.principal
  where id = old.admin_id;

  return null;
end;
$func$ language plpgsql
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- _enforce_service_account_admin_group_not_space_admin
-------------------------------------------------------------------------------
create or replace function {{schema}}._enforce_service_account_admin_group_not_space_admin()
returns trigger
as $func$
begin
  if new.admin
    and {{schema}}.service_account_for_admin_group(new.principal_id) is not null
  then
    raise exception
      'service-account admin group % cannot be a space-admin group', new.principal_id
      using errcode = '23514';
  end if;

  return new;
end;
$func$ language plpgsql
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

do $$ begin
  if not exists
  (
    select 1 from pg_trigger
    where tgrelid = '{{schema}}.principal'::regclass
    and tgname = 'principal_service_account_invariants'
  ) then
    create trigger principal_service_account_invariants
    before insert or update or delete on {{schema}}.principal
    for each row
    execute function {{schema}}._enforce_service_account_principal_invariants();
  end if;
end $$;

do $$ begin
  if not exists
  (
    select 1 from pg_trigger
    where tgrelid = '{{schema}}.principal'::regclass
    and tgname = 'principal_service_account_delete_admin_group'
  ) then
    create trigger principal_service_account_delete_admin_group
    after delete on {{schema}}.principal
    for each row when (old.kind = 's')
    execute function {{schema}}._delete_service_account_admin_group();
  end if;
end $$;

do $$ begin
  if not exists
  (
    select 1 from pg_trigger
    where tgrelid = '{{schema}}.principal_space'::regclass
    and tgname = 'principal_space_service_account_admin_group_not_admin'
  ) then
    create trigger principal_space_service_account_admin_group_not_admin
    before insert or update on {{schema}}.principal_space
    for each row
    execute function {{schema}}._enforce_service_account_admin_group_not_space_admin();
  end if;
end $$;
