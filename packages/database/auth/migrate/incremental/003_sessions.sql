-------------------------------------------------------------------------------
-- sessions  (better-auth model: session)
-- DELIBERATE DIVERGENCE FROM better-auth: we store sha256(token) in `token_hash`,
-- not the raw token. Our own validateSession hashes the presented token and looks
-- up by hash, so a database read never yields usable bearer tokens. (The BA library
-- reads sessions by raw-token equality and can't hash here; if we ever adopt it,
-- reconciling is cheap — switch to a plaintext `token` column and truncate, since
-- sessions are disposable.)
-------------------------------------------------------------------------------
create table {{schema}}.sessions
( id          uuid        not null primary key default uuidv7() check (uuid_extract_version(id) = 7)
, user_id     uuid        not null references {{schema}}.users (id) on delete cascade
, token_hash  bytea       not null                            -- sha256(rawToken); rawToken is 256-bit CSPRNG, shown to client only
, expires_at  timestamptz not null
, ip_address  text                                            -- better-auth parity, nullable
, user_agent  text                                            -- better-auth parity, nullable
, created_at  timestamptz not null default now()
);

create unique index sessions_token_hash_uniq on {{schema}}.sessions (token_hash); -- the auth lookup
create index sessions_user_id_idx    on {{schema}}.sessions (user_id);            -- revoke-all-by-user
create index sessions_expires_at_idx on {{schema}}.sessions (expires_at);         -- expired-row sweeps
