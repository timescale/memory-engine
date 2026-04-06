-- ===== OAuth Account (provider links) =====
create table {{schema}}.oauth_account
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, user_id uuid not null references {{schema}}."user" on delete cascade
, provider text not null check (provider in ('google', 'github'))
, provider_account_id text not null
, email citext
, access_token text
, refresh_token text
, token_expires_at timestamptz
, created_at timestamptz not null default now()
, updated_at timestamptz
, unique (provider, provider_account_id)
);

create index idx_oauth_account_user on {{schema}}.oauth_account (user_id);

create trigger oauth_account_updated_at
    before update on {{schema}}.oauth_account
    for each row
    execute function {{schema}}.update_updated_at();

-- ===== API Key (principal-scoped) =====
create table {{schema}}.api_key
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, principal_id uuid not null
, principal_type text not null check (principal_type in ('user', 'agent'))
, lookup_id text unique not null check (lookup_id ~ '^[A-Za-z0-9_-]{16}$')
, key_hash text not null
, name text not null
, expires_at timestamptz
, last_used_at timestamptz
, created_at timestamptz not null default now()
, revoked_at timestamptz
);

create index idx_api_key_principal on {{schema}}.api_key (principal_id);
create index idx_api_key_lookup on {{schema}}.api_key (lookup_id) where revoked_at is null;

-- ===== Session (for OAuth flow) =====
create table {{schema}}.session
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, user_id uuid not null references {{schema}}."user" on delete cascade
, token text unique not null
, expires_at timestamptz not null
, created_at timestamptz not null default now()
);

create index idx_session_user on {{schema}}.session (user_id);
create index idx_session_token on {{schema}}.session (token) where expires_at > now();
create index idx_session_expires on {{schema}}.session (expires_at);
