-------------------------------------------------------------------------------
-- Better Auth / @better-auth/oauth-provider 1.7.10.
-- Source: oauth-provider's schema in dist/authorize-*.mjs; core get-tables;
-- https://www.better-auth.com/docs/guides/1-7-upgrade-guide (1.7.3+ revision).
-- Accounts STILL use (provider_id, account_id): issuer was reverted in 1.7.3.
-- Do not rewrite social identities, session tokens, or OAuth token hashes.
-------------------------------------------------------------------------------

-- JWT's adapter treats null alg/crv on legacy keys as the configured default.
-- Preserve encrypted key material; no speculative decode/re-encryption.
alter table {{schema}}.jwks add column alg text, add column crv text;

-- Backfill authentication policy before the provider stops reading public/type.
-- Ambiguous historical registrations require operator review, not a guess that
-- could turn a confidential client into a public one or relax redirect checks.
do $migration$
begin
  if exists (select 1 from {{schema}}.oauth_client
             where type is null or type not in ('web', 'native')) then
    -- 1.6 allowed omitted type even with loopback/private-use redirects. In
    -- 1.7 a null application_type becomes web on updates, breaking native
    -- clients. Redirects alone do not prove the intended application policy.
    raise exception 'Review OAuth client types before upgrading to Better Auth 1.7 (set an explicit web/native type for every legacy client, including omitted types)';
  end if;
  if exists (select 1 from {{schema}}.oauth_client
             where (public is true and token_endpoint_auth_method is not null
                    and token_endpoint_auth_method <> 'none')
                or (public is not true and token_endpoint_auth_method = 'none')) then
    raise exception 'Review conflicting public OAuth client authentication methods before upgrading to Better Auth 1.7';
  end if;
end
$migration$;

alter table {{schema}}.oauth_client
  add column application_type text
, add column client_discovery_id text
, add column client_credentials_scopes jsonb default '[]'::jsonb
, add column backchannel_logout_uri text
, add column backchannel_logout_session_required boolean
, add column jwks text
, add column jwks_uri text
, add column dpop_bound_access_tokens boolean default false;

update {{schema}}.oauth_client
set application_type = type
  , token_endpoint_auth_method = coalesce(token_endpoint_auth_method,
      case when public is true then 'none' else 'client_secret_basic' end)
  , client_credentials_scopes = '[]'::jsonb;
-- public/type are retained as inert legacy columns for inspection. 1.7 neither
-- reads nor writes them. No client ids, secrets, registrations or grants change.
-- Discovery provenance cannot be inferred and deliberately stays null.

create table {{schema}}.oauth_resource
( id                                text not null primary key default (uuidv7()::text)
, identifier                        text not null unique
, name                              text not null
, access_token_ttl                  integer
, refresh_token_ttl                 integer
, signing_algorithm                 text
, signing_key_id                    text
, allowed_scopes                    jsonb
, custom_claims                     jsonb
, dpop_bound_access_tokens_required  boolean default false
, disabled                          boolean default false
, created_at                        timestamptz
, updated_at                        timestamptz
, policy_version                    integer default 1
, metadata                          jsonb
);

create table {{schema}}.oauth_client_resource
( id          text not null primary key default (uuidv7()::text)
, client_id   text not null references {{schema}}.oauth_client (client_id) on delete cascade
, resource_id text not null references {{schema}}.oauth_resource (identifier) on delete cascade
, metadata    jsonb
, created_at  timestamptz
, unique (client_id, resource_id)
);
create index oauth_client_resource_resource_idx on {{schema}}.oauth_client_resource (resource_id);

alter table {{schema}}.oauth_refresh_token
  add column authorization_code_id text
, add column resources jsonb
, add column requested_user_info_claims jsonb
, add column rotated_at timestamptz
, add column rotation_replay_response text
, add column rotation_replay_expires_at timestamptz
, add column confirmation jsonb;
create index oauth_refresh_token_authorization_code_idx on {{schema}}.oauth_refresh_token (authorization_code_id);

alter table {{schema}}.oauth_access_token
  add column authorization_code_id text
, add column resources jsonb
, add column requested_user_info_claims jsonb
, add column revoked timestamptz
, add column confirmation jsonb;
create index oauth_access_token_authorization_code_idx on {{schema}}.oauth_access_token (authorization_code_id);

alter table {{schema}}.oauth_consent
  add column resources jsonb
, add column requested_user_info_claims jsonb
, alter column user_id drop not null;

-- No resource backfill: 1.6 issued unbound opaque tokens. Inventing audiences
-- would widen existing grants. The CLI continues requesting no resource.
create table {{schema}}.oauth_client_assertion
( id         text not null primary key default (uuidv7()::text)
, expires_at timestamptz not null
);
create index oauth_client_assertion_expires_idx on {{schema}}.oauth_client_assertion (expires_at);

-- The standalone deviceAuthorization schema is unchanged. 007 already provides
-- the unique device_code/user_code indexes required by 1.7. Do NOT add the
-- opt-in oauthDeviceAuthorization fields or convert pending device requests.
