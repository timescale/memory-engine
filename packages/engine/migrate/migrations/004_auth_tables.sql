-- ===== Users =====
-- User: thing that accesses memories, or a role (can_login = false)
-- owned_by is a soft FK to accounts.identity (nullable for service users)
-- Note: "user" is a reserved word, must be quoted
create table {{schema}}."user"
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, name text not null
, owned_by uuid                            -- soft FK to accounts.identity
, can_login boolean not null default true  -- false = role (grant container)
, superuser boolean not null default false
, createrole boolean not null default false -- can create other users/roles
, created_at timestamptz not null default now()
, updated_at timestamptz
);

create index idx_user_owned_by on {{schema}}."user" (owned_by) where owned_by is not null;

create trigger user_updated_at
    before update on {{schema}}."user"
    for each row
    execute function {{schema}}.update_updated_at();

-- ===== API Keys =====
-- Engine-scoped, user-scoped authentication
create table {{schema}}.api_key
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, user_id uuid not null references {{schema}}."user" on delete cascade
, lookup_id text unique not null check (lookup_id ~ '^[A-Za-z0-9_-]{16}$')
, key_hash text not null
, name text not null
, expires_at timestamptz
, last_used_at timestamptz
, created_at timestamptz not null default now()
, revoked_at timestamptz
);

create index idx_api_key_user on {{schema}}.api_key (user_id);
create index idx_api_key_lookup on {{schema}}.api_key (lookup_id) where revoked_at is null;

-- ===== Tree Grants =====
create table {{schema}}.tree_grant
( id            uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, user_id       uuid not null references {{schema}}."user"(id) on delete cascade
, tree_path     ltree not null
, actions       text[] not null
, granted_by    uuid references {{schema}}."user"(id)
, created_at    timestamptz not null default now()
, with_grant_option boolean not null default false
, constraint valid_actions check (
    actions <@ '{read,create,update,delete}'::text[]
  )
);

create unique index idx_tree_grant_unique
  on {{schema}}.tree_grant (user_id, tree_path);

create index idx_tree_grant_user
  on {{schema}}.tree_grant using btree (user_id);

create index idx_tree_grant_path
  on {{schema}}.tree_grant using gist (tree_path);

-- ===== Role Membership =====
create table {{schema}}.role_membership
( role_id   uuid not null references {{schema}}."user"(id) on delete cascade
, member_id uuid not null references {{schema}}."user"(id) on delete cascade
, with_admin_option boolean not null default false
, created_at timestamptz not null default now()
, primary key (role_id, member_id)
, constraint no_self_membership check (role_id <> member_id)
);

create index idx_role_membership_member on {{schema}}.role_membership(member_id);

-- ===== Cycle Detection =====
create function {{schema}}.would_create_cycle
( _role_id uuid
, _member_id uuid
)
returns boolean
as $func$
  with recursive ancestors(id) as (
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
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, pg_temp
;

-- ===== Tree Ownership =====
create table {{schema}}.tree_owner
( tree_path    ltree primary key
, user_id      uuid not null references {{schema}}."user"(id) on delete cascade
, created_by   uuid references {{schema}}."user"(id)
, created_at   timestamptz not null default now()
);

create index idx_tree_owner_user on {{schema}}.tree_owner (user_id);
create index idx_tree_owner_gist on {{schema}}.tree_owner using gist (tree_path);

-- ===== Access Checking (role-aware) =====
-- Returns set of tree paths the user can access for the given action.
-- Superusers get ''::ltree (empty root) which matches all paths via <@.

create function {{schema}}.tree_access
( _user_id uuid
, _action text
)
returns setof ltree
as $func$
  with recursive effective_roles(user_id) as
  (
    select _user_id
    union
    select rm.role_id
    from {{schema}}.role_membership rm
    inner join effective_roles er on (er.user_id = rm.member_id)
  )
  select distinct tree_path
  from
  (
    -- superuser: empty ltree matches everything via <@
    select ''::ltree as tree_path
    from {{schema}}."user" u
    inner join effective_roles er on (u.id = er.user_id)
    where u.superuser
    union
    -- ownership grants full access
    select o.tree_path
    from {{schema}}.tree_owner o
    inner join effective_roles er on (er.user_id = o.user_id)
    union
    -- explicit grants for the requested action
    select g.tree_path
    from {{schema}}.tree_grant g
    inner join effective_roles er on (er.user_id = g.user_id)
    where _action = any(g.actions)
  )
$func$
language sql stable security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

revoke all on function {{schema}}.tree_access(uuid, text) from public;
grant execute on function {{schema}}.tree_access(uuid, text) to me_ro, me_rw;

-- defense in depth: revoke PUBLIC access on auth tables
revoke all on {{schema}}."user" from public;
revoke all on {{schema}}.api_key from public;
revoke all on {{schema}}.tree_grant from public;
revoke all on {{schema}}.role_membership from public;
revoke all on {{schema}}.tree_owner from public;

-- ===== RLS on memory =====
alter table {{schema}}.memory enable row level security;

create policy memory_select on {{schema}}.memory
  for select to me_ro, me_rw
  using
  (
    exists
    (
      select true
      from {{schema}}.tree_access(current_setting('me.user_id', true)::uuid, 'read') ta(tree_path)
      where tree <@ ta.tree_path
    )
  );

create policy memory_insert on {{schema}}.memory
  for insert to me_rw
  with check
  (
    exists
    (
      select true
      from {{schema}}.tree_access(current_setting('me.user_id', true)::uuid, 'create') ta(tree_path)
      where tree <@ ta.tree_path
    )
  );

create policy memory_update on {{schema}}.memory
  for update to me_rw
  using
  (
    exists
    (
      select true
      from {{schema}}.tree_access(current_setting('me.user_id', true)::uuid, 'update') ta(tree_path)
      where tree <@ ta.tree_path
    )
  )
  with check
  (
    exists
    (
      select true
      from {{schema}}.tree_access(current_setting('me.user_id', true)::uuid, 'update') ta(tree_path)
      where tree <@ ta.tree_path
    )
  );

create policy memory_delete on {{schema}}.memory
  for delete to me_rw
  using
  (
    exists
    (
      select true
      from {{schema}}.tree_access(current_setting('me.user_id', true)::uuid, 'delete') ta(tree_path)
      where tree <@ ta.tree_path
    )
  );

-- ===== Memory FK =====
alter table {{schema}}.memory add constraint memory_created_by_fk
  foreign key (created_by) references {{schema}}."user"(id) on delete set null;
