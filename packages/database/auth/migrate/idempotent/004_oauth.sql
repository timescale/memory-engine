-------------------------------------------------------------------------------
-- cleanup_expired_oauth_tokens (cron)
-- The OAuth 2.1 authorization server (@better-auth/oauth-provider) owns its
-- token tables; better-auth does not purge expired rows on its own, so this
-- periodic sweep reclaims expired access + refresh tokens. (The bespoke device
-- flow + its tables/functions were dropped in incremental/006.)
-------------------------------------------------------------------------------
create or replace function {{schema}}.cleanup_expired_oauth_tokens()
returns bigint
as $func$
  with a as
  (
    delete from {{schema}}.oauth_access_token where expires_at <= now() returning 1
  )
  , r as
  (
    delete from {{schema}}.oauth_refresh_token where expires_at <= now() returning 1
  )
  select (select count(*) from a) + (select count(*) from r)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
