-------------------------------------------------------------------------------
-- principal
-------------------------------------------------------------------------------
create table core.principal
( id uuid not null primary key default uuidv7() check (uuid_extract_version(id) = 7)
, user_id uuid unique nulls distinct generated always as (case when kind = 'user' then id else null end) stored
, group_id uuid unique nulls distinct generated always as (case when kind = 'group' then id else null end) stored
, agent_id uuid unique nulls distinct generated always as (case when kind = 'agent' then id else null end) stored
, member_id uuid unique nulls distinct generated always as (case when kind in ('user', 'agent') then id else null end) stored
, owner_id uuid references core.principal (user_id) on delete cascade -- points to agent's owner
, space_id uuid references core.space (id) on delete cascade
, kind text not null check (kind in ('group', 'user', 'agent'))
, name citext not null check (name::text !~ '/')
, created_at timestamptz not null default now()
, updated_at timestamptz
, check
  (
    (kind = 'agent' and owner_id is not null) -- agents are owned by a user
    or
    (kind != 'agent' and owner_id is null) -- users and groups have no owner
  )
, check
  (
    (kind = 'group' and space_id is not null) -- groups belong to a single space
    or
    (kind != 'group' and space_id is null) -- users and agents are global
  )
);

-- users must have a globally unique name
create unique index on core.principal (name) where user_id is not null;
-- each user's agents must have a unique name (per that user)
create unique index on core.principal (owner_id, name) where agent_id is not null;
-- each space's groups must have a unique name (per that space)
create unique index on core.principal (space_id, name) include (group_id) where group_id is not null;
