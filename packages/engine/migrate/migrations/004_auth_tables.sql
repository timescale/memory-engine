-- ===== Principals =====
create table {{schema}}.principal
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, email citext unique nulls distinct    -- NULL for agents
, name citext not null unique
, superuser boolean not null default false
, createrole boolean not null default false
, can_login boolean not null default true  -- false = role
, password_hash text               -- NULL = no password (role or API-key-only)
, created_at timestamptz not null default now()
, updated_at timestamptz
, constraint no_password_for_roles check (can_login or password_hash is null)
);

create trigger principal_updated_at
    before update on {{schema}}.principal
    for each row
    execute function {{schema}}.update_updated_at();

-- ===== API Keys =====
create table {{schema}}.api_key
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, principal_id uuid not null references {{schema}}.principal(id) on delete cascade
, name text not null
, lookup_id text not null unique check (lookup_id ~ '^[A-Za-z0-9_-]{16}$')
, key_hash text not null
, expires_at timestamptz not null default 'infinity'::timestamptz
, created_at timestamptz not null default now()
, updated_at timestamptz
);

create index idx_api_key_principal on {{schema}}.api_key(principal_id);
create index idx_api_key_expires on {{schema}}.api_key(expires_at) where expires_at < 'infinity'::timestamptz;

create trigger api_key_updated_at
    before update on {{schema}}.api_key
    for each row
    execute function {{schema}}.update_updated_at();

-- prevent API keys for non-login principals
create function {{schema}}.check_api_key_login()
returns trigger
as $func$
begin
  if not (select can_login from {{schema}}.principal where id = new.principal_id) then
    raise exception 'Cannot create API key for non-login principal (role)';
  end if;
  return new;
end;
$func$ language plpgsql volatile security definer
set search_path to pg_catalog, {{schema}}, pg_temp;

create trigger api_key_check_login
    before insert or update on {{schema}}.api_key
    for each row
    execute function {{schema}}.check_api_key_login();

-- ===== Tree Grants =====
create table {{schema}}.tree_grant
( id            uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, principal_id  uuid not null references {{schema}}.principal(id) on delete cascade
, tree_path     ltree not null
, actions       text[] not null
, granted_by    uuid references {{schema}}.principal(id)
, created_at    timestamptz not null default now()
, with_grant_option boolean not null default false
, constraint valid_actions check (
    actions <@ '{read,create,update,delete}'::text[]
  )
);

create unique index idx_tree_grant_unique
  on {{schema}}.tree_grant (principal_id, tree_path);

create index idx_tree_grant_principal
  on {{schema}}.tree_grant using btree (principal_id);

create index idx_tree_grant_path
  on {{schema}}.tree_grant using gist (tree_path);

-- ===== Role Membership =====
create table {{schema}}.role_membership
( role_id   uuid not null references {{schema}}.principal(id) on delete cascade
, member_id uuid not null references {{schema}}.principal(id) on delete cascade
, with_admin_option boolean not null default false
, created_at timestamptz not null default now()
, primary key (role_id, member_id)
, constraint no_self_membership check (role_id <> member_id)
);

create index idx_role_membership_member on {{schema}}.role_membership(member_id);

-- ===== Cycle Detection =====
create function {{schema}}.would_create_cycle(p_role_id uuid, p_member_id uuid)
returns boolean language sql stable security invoker
set search_path to pg_catalog, {{schema}}, pg_temp
as $$
  with recursive ancestors(id) as (
    select rm.role_id from {{schema}}.role_membership rm where rm.member_id = p_role_id
    union
    select rm.role_id from {{schema}}.role_membership rm join ancestors a on a.id = rm.member_id
  )
  select p_member_id = p_role_id
      or exists (select 1 from ancestors where id = p_member_id)
$$;

-- ===== Tree Ownership =====
create table {{schema}}.tree_owner
( tree_path    ltree primary key
, principal_id uuid not null references {{schema}}.principal(id) on delete cascade
, created_by   uuid references {{schema}}.principal(id)
, created_at   timestamptz not null default now()
);

create index idx_tree_owner_principal on {{schema}}.tree_owner (principal_id);
create index idx_tree_owner_gist on {{schema}}.tree_owner using gist (tree_path);

-- ===== Access Checking (role-aware) =====

-- 3-arg version: single source of truth, accepts explicit principal_id
create function {{schema}}.has_tree_access(p_principal_id uuid, p_tree ltree, p_action text)
returns boolean language sql stable security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
as $$
  with recursive effective_roles(principal_id) as (
    select p_principal_id
    union
    select rm.role_id from {{schema}}.role_membership rm
    join effective_roles er on er.principal_id = rm.member_id
  )
  select
    -- superuser bypass
    exists (
      select 1 from {{schema}}.principal
      where id = p_principal_id and superuser
    )
    or
    -- ownership (any ancestor)
    exists (
      select 1 from {{schema}}.tree_owner o
      join effective_roles er on er.principal_id = o.principal_id
      where p_tree <@ o.tree_path
    )
    or
    -- explicit grant
    exists (
      select 1 from {{schema}}.tree_grant g
      join effective_roles er on er.principal_id = g.principal_id
      where p_tree <@ g.tree_path and p_action = any(g.actions)
    )
$$;

revoke all on function {{schema}}.has_tree_access(uuid, ltree, text) from public;
grant execute on function {{schema}}.has_tree_access(uuid, ltree, text) to me_ro, me_rw;

-- 2-arg version: used by RLS policies, reads principal from session context
create function {{schema}}.has_tree_access(p_tree ltree, p_action text)
returns boolean language sql stable security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
as $$
  select {{schema}}.has_tree_access(
    current_setting('me.principal_id', true)::uuid,
    p_tree,
    p_action
  )
$$;

revoke all on function {{schema}}.has_tree_access(ltree, text) from public;

-- defense in depth: revoke PUBLIC access on auth tables
revoke all on {{schema}}.principal from public;
revoke all on {{schema}}.api_key from public;
revoke all on {{schema}}.tree_grant from public;
revoke all on {{schema}}.role_membership from public;
revoke all on {{schema}}.tree_owner from public;
grant execute on function {{schema}}.has_tree_access(ltree, text) to me_ro, me_rw;

-- ===== RLS on memory =====
alter table {{schema}}.memory enable row level security;

create policy memory_select on {{schema}}.memory
  for select to me_ro, me_rw
  using ({{schema}}.has_tree_access(tree, 'read'));

create policy memory_insert on {{schema}}.memory
  for insert to me_rw
  with check ({{schema}}.has_tree_access(tree, 'create'));

create policy memory_update on {{schema}}.memory
  for update to me_rw
  using ({{schema}}.has_tree_access(tree, 'update'))
  with check ({{schema}}.has_tree_access(tree, 'update'));

create policy memory_delete on {{schema}}.memory
  for delete to me_rw
  using ({{schema}}.has_tree_access(tree, 'delete'));

-- ===== Memory FK =====
alter table {{schema}}.memory add constraint memory_created_by_fk
  foreign key (created_by) references {{schema}}.principal(id) on delete set null;
