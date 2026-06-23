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
-- OAuth provider tables (oauthClient/oauthAccessToken/oauthRefreshToken/
-- oauthConsent) + the jwt plugin's `jwks` table are NEW and library-owned: we
-- never query them directly, so they use better-auth's native (camelCase) names
-- — quoted here — rather than the snake_case house style. Their DDL mirrors
-- `better-auth generate` (string[] -> jsonb), with two adaptations: ids are
-- DB-generated text (`uuidv7()::text`, since generateId:false omits them and
-- better-auth treats ids as opaque strings), and FK columns that reference our
-- uuid PKs (users.id, sessions.id) are `uuid`; access/refresh tokens are stored
-- HASHED at rest by the provider (storeTokens default).
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
create table {{schema}}."jwks"
( "id"         text        not null primary key default (uuidv7()::text)
, "publicKey"  text        not null
, "privateKey" text        not null
, "createdAt"  timestamptz not null default now()
, "expiresAt"  timestamptz
);

-- OAuth client registry (clientId is the public, referenced client identifier).
create table {{schema}}."oauthClient"
( "id"                      text        not null primary key default (uuidv7()::text)
, "clientId"                text        not null unique
, "clientSecret"            text
, "disabled"                boolean
, "skipConsent"             boolean
, "enableEndSession"        boolean
, "subjectType"             text
, "scopes"                  jsonb
, "userId"                  uuid        references {{schema}}.users (id) on delete cascade
, "createdAt"               timestamptz not null default now()
, "updatedAt"               timestamptz not null default now()
, "name"                    text
, "uri"                     text
, "icon"                    text
, "contacts"                jsonb
, "tos"                     text
, "policy"                  text
, "softwareId"              text
, "softwareVersion"         text
, "softwareStatement"       text
, "redirectUris"            jsonb       not null
, "postLogoutRedirectUris"  jsonb
, "tokenEndpointAuthMethod"  text
, "grantTypes"              jsonb
, "responseTypes"           jsonb
, "public"                  boolean
, "type"                    text
, "requirePKCE"             boolean
, "referenceId"             text
, "metadata"                jsonb
);

-- Opaque refresh tokens (offline_access). Stored hashed (storeTokens default).
create table {{schema}}."oauthRefreshToken"
( "id"          text        not null primary key default (uuidv7()::text)
, "token"       text        not null unique
, "clientId"    text        not null references {{schema}}."oauthClient" ("clientId") on delete cascade
, "sessionId"   uuid        references {{schema}}.sessions (id) on delete set null
, "userId"      uuid        not null references {{schema}}.users (id) on delete cascade
, "referenceId" text
, "expiresAt"   timestamptz not null
, "createdAt"   timestamptz not null default now()
, "revoked"     timestamptz
, "authTime"    timestamptz
, "scopes"      jsonb       not null
);
create index "oauthRefreshToken_expiresAt_idx" on {{schema}}."oauthRefreshToken" ("expiresAt");

-- Opaque access tokens. Stored hashed (storeTokens default); validated by introspection.
create table {{schema}}."oauthAccessToken"
( "id"          text        not null primary key default (uuidv7()::text)
, "token"       text        not null unique
, "clientId"    text        not null references {{schema}}."oauthClient" ("clientId") on delete cascade
, "sessionId"   uuid        references {{schema}}.sessions (id) on delete set null
, "userId"      uuid        references {{schema}}.users (id) on delete cascade
, "referenceId" text
, "refreshId"   text        references {{schema}}."oauthRefreshToken" ("id") on delete cascade
, "expiresAt"   timestamptz not null
, "createdAt"   timestamptz not null default now()
, "scopes"      jsonb       not null
);
create index "oauthAccessToken_expiresAt_idx" on {{schema}}."oauthAccessToken" ("expiresAt");

-- Per-(client,user) consent records.
create table {{schema}}."oauthConsent"
( "id"          text        not null primary key default (uuidv7()::text)
, "clientId"    text        not null references {{schema}}."oauthClient" ("clientId") on delete cascade
, "userId"      uuid        references {{schema}}.users (id) on delete cascade
, "referenceId" text
, "scopes"      jsonb       not null
, "createdAt"   timestamptz not null default now()
, "updatedAt"   timestamptz not null default now()
);
