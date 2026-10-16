-------------------------------------------------------------------------------
-- cleanup_expired_sessions (cron)
-- Session CRUD + validation is owned by the better-auth adapter (it queries the
-- `sessions` table directly). Keep the periodic expired-row sweep and targeted
-- OAuth refresh normalization here; better-auth does not purge expired rows on
-- its own. Functions reading retired token_hash were dropped in incremental/006.
-------------------------------------------------------------------------------
create or replace function {{schema}}.cleanup_expired_sessions()
returns bigint
as $func$
declare
  _deleted bigint;
begin
  -- 1.7 access-token validation checks the bound session. The FK uses SET NULL:
  -- deleting an expired session without revoking its access tokens would turn
  -- inactive bound tokens into active unbound ones. Lock against sliding-session
  -- refresh, revoke first, then let the FK clear the reference. Offline refresh
  -- grants deliberately survive ordinary session expiry (provider semantics).
  perform id from {{schema}}.sessions where expires_at <= now() for update;
  update {{schema}}.oauth_access_token t set revoked = now()
  where t.revoked is null and t.session_id in
    (select id from {{schema}}.sessions where expires_at <= now());
  -- OIDC logout semantics: only genuine offline grants survive the browser
  -- session. A refresh with narrowed scopes may no longer have offline_access.
  update {{schema}}.oauth_refresh_token t set revoked = now()
  where t.revoked is null and not (t.scopes @> '["offline_access"]'::jsonb)
    and t.session_id in
      (select id from {{schema}}.sessions where expires_at <= now());
  delete from {{schema}}.sessions where expires_at <= now();
  get diagnostics _deleted = row_count;
  return _deleted;
end
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- Before the provider reads a refresh grant, normalize just that grant's ended
-- browser-session association. The provider otherwise copies an expired
-- session_id to every new token until the periodic sweep deletes the session.
-- Keep OLD access tokens bound/inactive; never clear their session_id here.
-------------------------------------------------------------------------------
{{fn prepare_oauth_refresh(_token text) returns void}}
create or replace function {{schema}}.prepare_oauth_refresh(_token text)
returns void
as $func$
declare
  _session_id uuid;
  _expires_at timestamptz;
begin
  -- Match the sweep's lock order (session before token), and serialize with
  -- sliding-session updates/deletion. Check expiry AFTER acquiring the lock.
  select s.id, s.expires_at into _session_id, _expires_at
  from {{schema}}.sessions s
  join {{schema}}.oauth_refresh_token t on t.session_id = s.id
  where t.token = _token and t.revoked is null
  for update of s;

  if found and _expires_at > clock_timestamp() then
    return;
  end if;

  -- One atomic statement/transaction, before issuance: detach a real offline
  -- grant, or revoke an online-only grant. No browser rows or unrelated grants
  -- are swept. Unbound online-only refresh rows are invalid too (e.g. narrowing
  -- an already detached offline grant must not create perpetual online access).
  update {{schema}}.oauth_refresh_token t
  set session_id = case when t.scopes @> '["offline_access"]'::jsonb
                        then null else t.session_id end
    , revoked = case when t.scopes @> '["offline_access"]'::jsonb
                     then t.revoked else clock_timestamp() end
  where t.token = _token and t.revoked is null
    and (t.session_id = _session_id
      or (t.session_id is null and not (t.scopes @> '["offline_access"]'::jsonb)));
end
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}
