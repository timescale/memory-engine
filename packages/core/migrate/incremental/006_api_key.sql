-------------------------------------------------------------------------------
-- api_key
-------------------------------------------------------------------------------
create table {{schema}}.api_key
( id uuid not null primary key default uuidv7() check (uuid_extract_version(id) = 7)
, member_id uuid not null references {{schema}}.principal (member_id) on delete cascade -- may be users or agents, not groups
, lookup_id text unique not null check (lookup_id ~ '^[A-Za-z0-9_-]{16}$')
, secret text not null -- hashed secret
, name text not null
, created_at timestamptz not null default now()
, expires_at timestamptz
, unique (member_id, name)
);
