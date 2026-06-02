-------------------------------------------------------------------------------
-- verifications  (better-auth model: verification)
-- Generic key/value-with-expiry store: email verification, password reset, magic
-- links, OTPs. Unused today (we do GitHub/Google OAuth only) but kept empty for
-- better-auth shape parity, so enabling the library later needs no migration.
-------------------------------------------------------------------------------
create table {{schema}}.verifications
( id         uuid        not null primary key default uuidv7() check (uuid_extract_version(id) = 7)
, identifier text        not null
, value      text        not null
, expires_at timestamptz not null
, created_at timestamptz not null default now()
, updated_at timestamptz
);

create index verifications_identifier_idx on {{schema}}.verifications (identifier);
create index verifications_expires_at_idx on {{schema}}.verifications (expires_at); -- expired-row sweeps
