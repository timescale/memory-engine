-------------------------------------------------------------------------------
-- 008_betterauth_1_7: schema additions for better-auth 1.7 / oauth-provider 1.7.
--
-- All new columns are nullable and all new tables start empty, so this is
-- additive. The one data change is on the seeded `me-cli` client: 1.7 dropped
-- the `public` / `type` columns and now decides "public client" from
-- `token_endpoint_auth_method = 'none'` and loopback-redirect rules from
-- `application_type = 'native'`. Without that update the CLI's code exchange
-- fails with "client secret must be provided". The legacy columns are left in
-- place (nullable, unread) so a rollback to 1.6 still works.
--
-- Columns follow the 006 snake_case convention and are mapped in
-- betterauth.ts `schema` overrides. Shapes come from
-- `packages/server/auth/dump-schema.ts`, which prints what the
-- installed better-auth expects for our exact plugin configuration.
-------------------------------------------------------------------------------

-- jwks: key algorithm / curve metadata (nullable; existing keys are RS/ES by
-- better-auth's default and it tolerates null).
alter table {{schema}}.jwks add column alg text;
alter table {{schema}}.jwks add column crv text;

-- oauth_client: 1.7 client model.
alter table {{schema}}.oauth_client add column client_discovery_id                 text;
alter table {{schema}}.oauth_client add column client_credentials_scopes           jsonb;
alter table {{schema}}.oauth_client add column backchannel_logout_uri              text;
alter table {{schema}}.oauth_client add column backchannel_logout_session_required boolean;
alter table {{schema}}.oauth_client add column application_type                    text;
alter table {{schema}}.oauth_client add column jwks                                text;
alter table {{schema}}.oauth_client add column jwks_uri                            text;
alter table {{schema}}.oauth_client add column dpop_bound_access_tokens            boolean;

-- The seeded first-party CLI client. `public = true` is the 1.6 spelling of
-- `token_endpoint_auth_method = 'none'`; `type = 'native'` of
-- `application_type = 'native'`.
update {{schema}}.oauth_client
   set token_endpoint_auth_method = 'none'
     , application_type           = 'native'
     , client_credentials_scopes  = '[]'::jsonb
 where client_id = 'me-cli';

-- oauth_refresh_token: grant binding (RFC 8707 resources, authorization code
-- linkage, claims), refresh-token rotation replay, DPoP confirmation.
alter table {{schema}}.oauth_refresh_token add column authorization_code_id      text;
alter table {{schema}}.oauth_refresh_token add column resources                  jsonb;
alter table {{schema}}.oauth_refresh_token add column requested_user_info_claims jsonb;
alter table {{schema}}.oauth_refresh_token add column rotated_at                 timestamptz;
alter table {{schema}}.oauth_refresh_token add column rotation_replay_response   text;
alter table {{schema}}.oauth_refresh_token add column rotation_replay_expires_at timestamptz;
alter table {{schema}}.oauth_refresh_token add column confirmation               jsonb;

-- oauth_access_token: same grant binding, plus `revoked` for back-channel logout.
alter table {{schema}}.oauth_access_token add column authorization_code_id      text;
alter table {{schema}}.oauth_access_token add column resources                  jsonb;
alter table {{schema}}.oauth_access_token add column requested_user_info_claims jsonb;
alter table {{schema}}.oauth_access_token add column revoked                    timestamptz;
alter table {{schema}}.oauth_access_token add column confirmation               jsonb;

-- oauth_consent
alter table {{schema}}.oauth_consent add column resources                  jsonb;
alter table {{schema}}.oauth_consent add column requested_user_info_claims jsonb;

-- Protected resources (RFC 8707). Unused: Memory Engine is the only resource
-- server and `resources` is not configured, but the plugin's schema declares
-- the tables and the adapter validates their presence at boot.
create table {{schema}}.oauth_resource
( id                                text        not null primary key default (uuidv7()::text)
, identifier                        text        not null unique
, name                              text        not null
, access_token_ttl                  integer
, refresh_token_ttl                 integer
, signing_algorithm                 text
, signing_key_id                    text
, allowed_scopes                    jsonb
, custom_claims                     jsonb
, dpop_bound_access_tokens_required boolean
, disabled                          boolean
, created_at                        timestamptz
, updated_at                        timestamptz
, policy_version                    integer
, metadata                          jsonb
);

create table {{schema}}.oauth_client_resource
( id          text        not null primary key default (uuidv7()::text)
, client_id   text        not null references {{schema}}.oauth_client (client_id) on delete cascade
, resource_id text        not null references {{schema}}.oauth_resource (identifier) on delete cascade
, metadata    jsonb
, created_at  timestamptz
, unique (client_id, resource_id)
);

-- Single-use `jti` tracking for private_key_jwt client assertions. Unused
-- (the CLI is a public client) but declared by the plugin.
create table {{schema}}.oauth_client_assertion
( id         text        not null primary key
, expires_at timestamptz not null
);
create index oauth_client_assertion_expires_at_idx on {{schema}}.oauth_client_assertion (expires_at);
