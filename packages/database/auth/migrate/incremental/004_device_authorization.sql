-------------------------------------------------------------------------------
-- device_authorization  (OAuth 2.0 device flow — RFC 8628)
-- Our own device-flow state (not a better-auth table). `user_id` (was identity_id)
-- is filled in by the OAuth callback once the human authorizes; the CLI polls by
-- device_code and exchanges an authorized row for a session.
-------------------------------------------------------------------------------
create table {{schema}}.device_authorization
( device_code text        not null primary key                                  -- CLI polling secret (32-byte base64url)
, user_code   text        not null unique                                       -- human-entered code, XXXX-XXXX
, provider    text        not null check (provider in ('google', 'github'))
, oauth_state text        not null unique                                       -- CSRF binding for the OAuth callback
, expires_at  timestamptz not null                                              -- short TTL (~15 min)
, last_poll   timestamptz                                                       -- rate-limiting the CLI poll
, user_id     uuid        references {{schema}}.users (id) on delete cascade    -- null until authorized
, denied      boolean     not null default false
, created_at  timestamptz not null default now()
);

create index device_authorization_expires_at_idx on {{schema}}.device_authorization (expires_at); -- expired-row sweeps
