-------------------------------------------------------------------------------
-- cleanup_expired_sessions (cron)
-- Session CRUD + validation is owned by the better-auth adapter (it queries the
-- `sessions` table directly). Only the periodic expired-row sweep remains here —
-- better-auth does not purge expired rows on its own. (The session functions that
-- read the retired `token_hash` column were dropped in incremental/006.)
-------------------------------------------------------------------------------
create or replace function {{schema}}.cleanup_expired_sessions()
returns bigint
as $func$
  with d as
  (
    delete from {{schema}}.sessions where expires_at <= now() returning 1
  )
  select count(*) from d
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
