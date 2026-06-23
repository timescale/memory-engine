-------------------------------------------------------------------------------
-- cleanup_expired_device_codes (cron)
-- The OAuth 2.0 device flow is owned by the better-auth deviceAuthorization
-- plugin (the `device_codes` table). Only the periodic expired-row sweep remains
-- here. (The bespoke device-flow functions + the `device_authorization` table
-- were dropped in incremental/006.)
-------------------------------------------------------------------------------
create or replace function {{schema}}.cleanup_expired_device_codes()
returns bigint
as $func$
  with d as
  (
    delete from {{schema}}.device_codes where expires_at <= now() returning 1
  )
  select count(*) from d
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
