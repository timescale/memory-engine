-- Device authorization for OAuth device flow (RFC 8628)
-- Stores state during the ~15 minute device flow window

create table {{schema}}.device_authorization (
  device_code   text        primary key,                                                  -- URL-safe base64, 32 bytes
  user_code     text        not null unique,                                              -- XXXX-XXXX format
  provider      text        not null,                                                     -- 'google' | 'github'
  oauth_state   text        not null unique,                                              -- CSRF protection
  expires_at    timestamptz not null,                                                     -- 15 minute TTL
  last_poll     timestamptz,                                                              -- rate limiting
  identity_id   uuid        references {{schema}}.identity(id) on delete cascade,         -- set when authorized
  denied        boolean     not null default false,                                       -- user denied access
  created_at    timestamptz not null default now()
);
