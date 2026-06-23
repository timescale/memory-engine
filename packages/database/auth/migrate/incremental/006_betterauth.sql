-------------------------------------------------------------------------------
-- 006_betterauth: adopt the better-auth library for human identity.
--
-- better-auth stores the raw session token and looks it up by equality, and it
-- round-trips that token through the session row (it re-emits it into the cookie
-- and keys refresh/sign-out on it), so storing a one-way hash is impossible. We
-- drop `token_hash` and add a plaintext, unique `token` (the CLI/bearer path is
-- hardened separately with requireSignature). Old hashed sessions have no
-- recoverable plaintext, so they are truncated — sessions are disposable and
-- users simply re-login.
--
-- The custom device flow is replaced by the better-auth deviceAuthorization
-- plugin, whose `deviceCode` model maps onto `device_codes` here.
--
-- Session + device CRUD now lives in the better-auth adapter, so the bespoke SQL
-- functions are dropped (only the expired-row sweeps remain, in idempotent/002
-- and idempotent/004). Explicit drops here clear them from already-migrated
-- databases; the idempotent files no longer recreate them.
-------------------------------------------------------------------------------

-- session functions that read token_hash / are now owned by the adapter
drop function if exists {{schema}}.create_session(uuid, bytea, timestamptz);
drop function if exists {{schema}}.validate_session(bytea);
drop function if exists {{schema}}.delete_session(uuid);
drop function if exists {{schema}}.delete_session_by_hash(bytea);
drop function if exists {{schema}}.delete_sessions_by_user(uuid);

-- sessions → better-auth shape: a plaintext, unique `token` + `updated_at`.
truncate table {{schema}}.sessions;
alter table {{schema}}.sessions add column token text not null;          -- raw session token (better-auth)
alter table {{schema}}.sessions add column updated_at timestamptz;       -- maintained by the adapter
drop index if exists {{schema}}.sessions_token_hash_uniq;
alter table {{schema}}.sessions drop column token_hash;
create unique index sessions_token_uniq on {{schema}}.sessions (token);  -- the auth lookup

-- the custom device flow → better-auth's deviceAuthorization plugin model
drop function if exists {{schema}}.create_device_auth(text, text, text, text, timestamptz);
drop function if exists {{schema}}.get_device_by_user_code(text);
drop function if exists {{schema}}.get_device_by_oauth_state(text);
drop function if exists {{schema}}.bind_device_user(text, uuid);
drop function if exists {{schema}}.approve_device(text);
drop function if exists {{schema}}.deny_device(text);
drop function if exists {{schema}}.poll_device(text, double precision);
drop function if exists {{schema}}.delete_device(text);
drop function if exists {{schema}}.delete_expired_devices();
drop table if exists {{schema}}.device_authorization;

create table {{schema}}.device_codes
( id               uuid        not null primary key default uuidv7() check (uuid_extract_version(id) = 7)
, device_code      text        not null unique           -- CLI polling secret
, user_code        text        not null unique           -- human-entered code (XXXX-XXXX)
, user_id          uuid        references {{schema}}.users (id) on delete cascade -- bound on approval
, client_id        text                                  -- RFC 8628 client id (optional)
, scope            text                                  -- requested scope (optional)
, status           text        not null                  -- pending | approved | denied (adapter-managed)
, expires_at       timestamptz not null                  -- short TTL
, last_polled_at   timestamptz                           -- poll rate-limiting
, polling_interval integer                               -- seconds between polls
, created_at       timestamptz not null default now()    -- adapter omits it; default fills in
);
create index device_codes_expires_at_idx on {{schema}}.device_codes (expires_at); -- expired-row sweeps
