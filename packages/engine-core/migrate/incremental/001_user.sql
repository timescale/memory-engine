
-------------------------------------------------------------------------------
-- users
-------------------------------------------------------------------------------
-- note: "user" is a reserved word, must be quoted
create table {{schema}}."user"
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, name citext not null unique
, superuser boolean not null default false
--, type text not null check (type in ('user', 'role', 'agent'))
, created_at timestamptz not null default now()
);
