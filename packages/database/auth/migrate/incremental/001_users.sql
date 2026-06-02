-------------------------------------------------------------------------------
-- users  (better-auth model: user)
-- "users" (plural) avoids the SQL reserved word "user".
-------------------------------------------------------------------------------
create table {{schema}}.users
( id             uuid        not null primary key default uuidv7() check (uuid_extract_version(id) = 7)
, name           text        not null
, email          citext      not null unique                   -- citext: case-insensitive, even if app-layer lowercasing is bypassed
, email_verified boolean     not null default false            -- set from the provider's verified-email flag
, image          text                                          -- optional avatar url (better-auth parity)
, created_at     timestamptz not null default now()
, updated_at     timestamptz                                   -- maintained by update_updated_at() trigger (idempotent/000)
);
