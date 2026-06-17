-------------------------------------------------------------------------------
-- verifications functions  (better-auth model: the generic short-lived
-- key/value-with-expiry store). Used for the browser OAuth-login `state` (CSRF
-- binding + the post-login redirect target), the way better-auth persists
-- social-login state — distinct from the RFC 8628 device flow, which keeps its
-- own state in device_authorization.
-------------------------------------------------------------------------------

-------------------------------------------------------------------------------
-- create_verification  (store a short-lived identifier -> value)
-------------------------------------------------------------------------------
create or replace function {{schema}}.create_verification
( _identifier text
, _value text
, _expires_at timestamptz
)
returns void
as $func$
  insert into {{schema}}.verifications (identifier, value, expires_at)
  values (_identifier, _value, _expires_at)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- consume_verification  (delete-on-read). Returns the value for an unexpired
-- identifier and removes the row so it can't be replayed. No rows if missing or
-- expired (the leftover expired row, if any, is reclaimed by the cleanup cron).
-------------------------------------------------------------------------------
create or replace function {{schema}}.consume_verification(_identifier text)
returns table (value text)
as $func$
  with d as
  (
    delete from {{schema}}.verifications
    where identifier = _identifier and expires_at > now()
    returning value
  )
  select value from d limit 1
$func$ language sql volatile strict rows 1 security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- cleanup_expired_verifications  (cron)
-------------------------------------------------------------------------------
create or replace function {{schema}}.cleanup_expired_verifications()
returns bigint
as $func$
  with d as
  (
    delete from {{schema}}.verifications where expires_at <= now() returning 1
  )
  select count(*) from d
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
