-------------------------------------------------------------------------------
-- cleanup_expired_device_codes (cron)
-- The better-auth device-authorization plugin owns the `device_code` table
-- (incremental/007) but does not purge expired rows on its own, so this periodic
-- sweep reclaims device codes past their (short) TTL. Mirrors the other
-- `cleanup_expired_*` sweeps.
-------------------------------------------------------------------------------
create or replace function {{schema}}.cleanup_expired_device_codes()
returns bigint
as $func$
  with d as
  (
    delete from {{schema}}.device_code where expires_at <= now() returning 1
  )
  select count(*) from d
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
