-- ===== OAuth Account (provider links) =====
create table {{schema}}.oauth_account
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, identity_id uuid not null references {{schema}}.identity on delete cascade
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

create index idx_oauth_account_identity on {{schema}}.oauth_account (identity_id);

create trigger oauth_account_updated_at
    before update on {{schema}}.oauth_account
    for each row
    execute function {{schema}}.update_updated_at();

-- ===== Session (for OAuth flow) =====
create table {{schema}}.session
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, identity_id uuid not null references {{schema}}.identity on delete cascade
, token text unique not null
, expires_at timestamptz not null
, created_at timestamptz not null default now()
);

create index idx_session_identity on {{schema}}.session (identity_id);
create index idx_session_token on {{schema}}.session (token);
create index idx_session_expires on {{schema}}.session (expires_at);
