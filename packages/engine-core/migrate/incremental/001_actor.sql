
-------------------------------------------------------------------------------
-- actor
-------------------------------------------------------------------------------
create table {{schema}}.actor
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, user_id uuid unique nulls distinct generated always as (case when kind = 'user' then id else null end) stored
, role_id uuid unique nulls distinct generated always as (case when kind = 'role' then id else null end) stored
, member_id uuid unique nulls distinct generated always as (case when kind in ('user', 'delegate') then id else null end) stored
, owner_id uuid references {{schema}}.actor (user_id) on delete cascade
, name citext not null check (name::text !~ '/')
, kind text not null check (kind in ('role', 'user', 'delegate'))
, created_at timestamptz not null default now()
, updated_at timestamptz
, check
  (
   (kind = 'delegate' and owner_id is not null)
   or
   (kind != 'delegate' and owner_id is null)
  )
);

create index on {{schema}}.actor (name);

create unique index actor_user_role_name_uidx on {{schema}}.actor (name) where kind in ('user', 'role');

create unique index actor_delegate_owner_name_uidx on {{schema}}.actor (owner_id, name) where kind = 'delegate';

-- built-in actors
-- user-admin can administer any user/role/delegate
-- tree-admin can administer *access* to any part of the tree
insert into {{schema}}.actor (id, name, kind)
values
  ('00584580-f000-7000-8000-000000000001', 'user-admin', 'role')
, ('00584580-f000-7000-8000-000000000002', 'tree-admin', 'role')
, ('00584580-f000-7000-8000-000000000003', 'owner'     , 'user')
;

/*
A role is a group of actors. Roles cannot be nested. So, a role only contains actors of type user and/or delegate.
Privileges can be assigned to roles and members of the role inherit them.

A user actor can authenticate and perform actions according to their privileges assigned.

Unlike postgres, a user is not a role. You cannot assign users to users.

A delegate is a user that is owned and managed by another user. The owner can assign privileges to it that the owner posesses.
*/
