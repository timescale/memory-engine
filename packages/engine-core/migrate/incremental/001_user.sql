
-------------------------------------------------------------------------------
-- users
-------------------------------------------------------------------------------
-- User: thing that accesses memories, or a role (can_login = false)
-- identity_id is a soft FK to accounts.identity (nullable for service users)
-- Note: "user" is a reserved word, must be quoted
create table {{schema}}."user"
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, name citext not null unique
, superuser boolean not null default false
, created_at timestamptz not null default now()
);
