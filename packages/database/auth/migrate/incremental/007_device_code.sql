-------------------------------------------------------------------------------
-- 007_device_code: OAuth 2.0 Device Authorization Grant (RFC 8628).
--
-- Backs better-auth's `device-authorization` plugin (enabled in betterauth.ts),
-- which lets a headless CLI (no browser — e.g. an agent harness in a sandbox)
-- log in: the CLI polls with a `device_code` while the human approves the paired
-- `user_code` in a browser. This is the better-auth PLUGIN table — distinct from
-- the retired bespoke `device_authorization` table (incremental/004, dropped in
-- 006). On approval the plugin mints a normal better-auth SESSION (not an OAuth
-- token), so there is no refresh token; the session slides via the adapter.
--
-- The plugin maps its camelCase `deviceCode` model onto these snake_case columns
-- via `schema` overrides in betterauth.ts. DDL follows the 006 conventions: the
-- id is DB-generated text (`uuidv7()::text`, since generateId:false), and the FK
-- to users.id (a uuid PK) is `uuid`. `polling_interval` holds milliseconds.
-------------------------------------------------------------------------------
create table {{schema}}.device_code
( id              text        not null primary key default (uuidv7()::text)
, device_code     text        not null                                              -- CLI polling secret
, user_code       text        not null                                              -- human-entered code shown in the CLI
, user_id         uuid        references {{schema}}.users (id) on delete cascade    -- bound once the browser claims the code
, expires_at      timestamptz not null                                             -- short TTL
, status          text        not null                                             -- pending | approved | denied
, last_polled_at  timestamptz                                                      -- rate-limits the CLI poll (slow_down)
, polling_interval integer                                                          -- min poll interval, milliseconds
, client_id       text                                                             -- the requesting client (validated == 'me-cli')
, scope           text                                                             -- requested scope, if any
);

create unique index device_code_device_code_uniq on {{schema}}.device_code (device_code); -- CLI poll lookup
create unique index device_code_user_code_uniq on {{schema}}.device_code (user_code);     -- browser claim/approve lookup
create index device_code_expires_at_idx on {{schema}}.device_code (expires_at);            -- expired-row sweeps
