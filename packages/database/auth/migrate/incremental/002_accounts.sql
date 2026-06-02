-------------------------------------------------------------------------------
-- accounts  (better-auth model: account)
-- One row per provider link. LOGIN-ONLY: we authenticate via GitHub/Google but
-- never call their APIs on the user's behalf, so the token/password columns are
-- kept (for better-auth shape parity) but left null and never written. Because
-- nothing sensitive is stored at rest, there is no token-encryption subsystem.
-------------------------------------------------------------------------------
create table {{schema}}.accounts
( id                       uuid        not null primary key default uuidv7() check (uuid_extract_version(id) = 7)
, user_id                  uuid        not null references {{schema}}.users (id) on delete cascade
, provider_id              text        not null check (provider_id in ('google', 'github')) -- was `provider`
, account_id               text        not null                                             -- provider's stable user id (was `provider_account_id`)
, access_token             text                                                             -- nullable, unused (login-only)
, refresh_token            text                                                             -- nullable, unused
, id_token                 text                                                             -- nullable, unused
, access_token_expires_at  timestamptz
, refresh_token_expires_at timestamptz
, scope                    text
, password                 text                                                             -- nullable, unused (OAuth-only, no email/password)
, created_at               timestamptz not null default now()
, updated_at               timestamptz
-- the OAuth sign-in lookup key + integrity rule: one external account -> one row
, unique (provider_id, account_id)
);

create index accounts_user_id_idx on {{schema}}.accounts (user_id);
