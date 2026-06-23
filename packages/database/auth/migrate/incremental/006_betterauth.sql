-------------------------------------------------------------------------------
-- 006_betterauth: adopt the better-auth library for human identity + an OAuth
-- 2.1 authorization server (@better-auth/oauth-provider).
--
-- Sessions (web cookie auth): better-auth round-trips the raw token through the
-- session row, so a one-way hash is impossible. We drop `token_hash` and add a
-- plaintext, unique `token` (the at-rest concern is limited to short-lived web
-- sessions; agent api keys stay hashed in core). Old hashed sessions have no
-- recoverable plaintext, so they are truncated — users simply re-login.
--
-- The bespoke session/device SQL functions are dropped (only the expired-row
-- sweeps remain, idempotent/002 + 004). Explicit drops clear them from
-- already-migrated dev databases; the idempotent files no longer recreate them.
--
-- OAuth provider tables (oauth_client/oauth_access_token/oauth_refresh_token/
-- oauth_consent) + the jwt plugin's `jwks` table are new. better-auth maps its
-- camelCase models onto these snake_case names via `schema` overrides in
-- betterauth.ts. The DDL mirrors `better-auth generate` (string[] -> jsonb),
-- with two adaptations: ids are DB-generated text (`uuidv7()::text`, since
-- generateId:false omits them and better-auth treats ids as opaque strings),
-- and FK columns that reference our uuid PKs (users.id, sessions.id) are `uuid`.
-- Access/refresh tokens are stored HASHED at rest by the provider.
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

-- retire the bespoke device flow (incl. an earlier device_codes attempt on this
-- branch) — the CLI now uses the OAuth authorization-code flow instead.
drop function if exists {{schema}}.create_device_auth(text, text, text, text, timestamptz);
drop function if exists {{schema}}.get_device_by_user_code(text);
drop function if exists {{schema}}.get_device_by_oauth_state(text);
drop function if exists {{schema}}.bind_device_user(text, uuid);
drop function if exists {{schema}}.approve_device(text);
drop function if exists {{schema}}.deny_device(text);
drop function if exists {{schema}}.poll_device(text, double precision);
drop function if exists {{schema}}.delete_device(text);
drop function if exists {{schema}}.delete_expired_devices();
drop function if exists {{schema}}.cleanup_expired_device_codes();
drop table if exists {{schema}}.device_authorization;
drop table if exists {{schema}}.device_codes;

-- jwt plugin: signing keyset (private key encrypted with BETTER_AUTH_SECRET).
create table {{schema}}.jwks
( id          text        not null primary key default (uuidv7()::text)
, public_key  text        not null
, private_key text        not null
, created_at  timestamptz not null default now()
, expires_at  timestamptz
);

-- OAuth client registry (client_id is the public, referenced client identifier).
create table {{schema}}.oauth_client
( id                         text        not null primary key default (uuidv7()::text)
, client_id                  text        not null unique
, client_secret              text
, disabled                   boolean
, skip_consent               boolean
, enable_end_session         boolean
, subject_type               text
, scopes                     jsonb
, user_id                    uuid        references {{schema}}.users (id) on delete cascade
, created_at                 timestamptz not null default now()
, updated_at                 timestamptz not null default now()
, name                       text
, uri                        text
, icon                       text
, contacts                   jsonb
, tos                        text
, policy                     text
, software_id                text
, software_version           text
, software_statement         text
, redirect_uris              jsonb       not null
, post_logout_redirect_uris  jsonb
, token_endpoint_auth_method text
, grant_types                jsonb
, response_types             jsonb
, public                     boolean
, type                       text
, require_pkce               boolean
, reference_id               text
, metadata                   jsonb
);

-- Opaque refresh tokens (offline_access). Stored hashed (storeTokens default).
create table {{schema}}.oauth_refresh_token
( id           text        not null primary key default (uuidv7()::text)
, token        text        not null unique
, client_id    text        not null references {{schema}}.oauth_client (client_id) on delete cascade
, session_id   uuid        references {{schema}}.sessions (id) on delete set null
, user_id      uuid        not null references {{schema}}.users (id) on delete cascade
, reference_id text
, expires_at   timestamptz not null
, created_at   timestamptz not null default now()
, revoked      timestamptz
, auth_time    timestamptz
, scopes       jsonb       not null
);
create index oauth_refresh_token_expires_at_idx on {{schema}}.oauth_refresh_token (expires_at);

-- Opaque access tokens. Stored hashed (storeTokens default); validated by introspection.
create table {{schema}}.oauth_access_token
( id           text        not null primary key default (uuidv7()::text)
, token        text        not null unique
, client_id    text        not null references {{schema}}.oauth_client (client_id) on delete cascade
, session_id   uuid        references {{schema}}.sessions (id) on delete set null
, user_id      uuid        references {{schema}}.users (id) on delete cascade
, reference_id text
, refresh_id   text        references {{schema}}.oauth_refresh_token (id) on delete cascade
, expires_at   timestamptz not null
, created_at   timestamptz not null default now()
, scopes       jsonb       not null
);
create index oauth_access_token_expires_at_idx on {{schema}}.oauth_access_token (expires_at);

-- Per-(client,user) consent records.
create table {{schema}}.oauth_consent
( id           text        not null primary key default (uuidv7()::text)
, client_id    text        not null references {{schema}}.oauth_client (client_id) on delete cascade
, user_id      uuid        references {{schema}}.users (id) on delete cascade
, reference_id text
, scopes       jsonb       not null
, created_at   timestamptz not null default now()
, updated_at   timestamptz not null default now()
);

-- Seed the first-party `me` CLI as a trusted public client: PKCE required,
-- consent skipped, loopback redirect (RFC 8252 — for a loopback IP the AS
-- ignores the port, so any http://127.0.0.1:<port>/callback matches). It is
-- listed in cachedTrustedClients (betterauth.ts), so it is immutable via the
-- CRUD endpoints; change it here. Idempotent.
insert into {{schema}}.oauth_client
  ( client_id, name, public, type, require_pkce, skip_consent
  , redirect_uris, grant_types, response_types, scopes )
values
  ( 'me-cli', 'me CLI', true, 'native', true, true
  , '["http://127.0.0.1/callback"]'::jsonb
  , '["authorization_code", "refresh_token"]'::jsonb
  , '["code"]'::jsonb
  , '["openid", "profile", "email", "offline_access"]'::jsonb )
on conflict (client_id) do nothing;
