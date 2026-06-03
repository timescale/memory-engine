-------------------------------------------------------------------------------
-- create_device_auth  (OAuth 2.0 device flow). status defaults to 'pending'.
-------------------------------------------------------------------------------
create or replace function {{schema}}.create_device_auth
( _device_code text
, _user_code text
, _provider text
, _oauth_state text
, _expires_at timestamptz
)
returns void
as $func$
  insert into {{schema}}.device_authorization
    (device_code, user_code, provider, oauth_state, expires_at)
  values
    (_device_code, _user_code, _provider, _oauth_state, _expires_at)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- get_device_by_user_code  (browser code entry; caller normalizes the code)
-------------------------------------------------------------------------------
create or replace function {{schema}}.get_device_by_user_code(_user_code text)
returns table
( device_code text
, user_code text
, provider text
, oauth_state text
, expires_at timestamptz
, last_poll timestamptz
, user_id uuid
, status text
, created_at timestamptz
)
as $func$
  select d.device_code, d.user_code, d.provider, d.oauth_state, d.expires_at,
         d.last_poll, d.user_id, d.status, d.created_at
  from {{schema}}.device_authorization d
  where d.user_code = _user_code and d.expires_at > now()
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- get_device_by_oauth_state  (OAuth callback + consent)
-------------------------------------------------------------------------------
create or replace function {{schema}}.get_device_by_oauth_state(_oauth_state text)
returns table
( device_code text
, user_code text
, provider text
, oauth_state text
, expires_at timestamptz
, last_poll timestamptz
, user_id uuid
, status text
, created_at timestamptz
)
as $func$
  select d.device_code, d.user_code, d.provider, d.oauth_state, d.expires_at,
         d.last_poll, d.user_id, d.status, d.created_at
  from {{schema}}.device_authorization d
  where d.oauth_state = _oauth_state and d.expires_at > now()
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- bind_device_user  (callback resolved the user; status stays 'pending' until
-- the human consents). Returns false if already bound / not pending / expired.
-------------------------------------------------------------------------------
create or replace function {{schema}}.bind_device_user(_device_code text, _user_id uuid)
returns bool
as $func$
  with u as
  (
    update {{schema}}.device_authorization
    set user_id = _user_id
    where device_code = _device_code
      and expires_at > now()
      and status = 'pending'
      and user_id is null
    returning 1
  )
  select exists (select 1 from u)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- approve_device  (the human consented). Requires a bound user + pending status.
-------------------------------------------------------------------------------
create or replace function {{schema}}.approve_device(_device_code text)
returns bool
as $func$
  with u as
  (
    update {{schema}}.device_authorization
    set status = 'approved'
    where device_code = _device_code
      and expires_at > now()
      and status = 'pending'
      and user_id is not null
    returning 1
  )
  select exists (select 1 from u)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- deny_device  (the human denied, or the OAuth step failed)
-------------------------------------------------------------------------------
create or replace function {{schema}}.deny_device(_device_code text)
returns bool
as $func$
  with u as
  (
    update {{schema}}.device_authorization
    set status = 'denied'
    where device_code = _device_code
      and expires_at > now()
      and status = 'pending'
    returning 1
  )
  select exists (select 1 from u)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- poll_device  (CLI polling — resolves the poll state in one call). Returns the
-- stored status (pending|approved|denied) straight through, plus two poll-only
-- outcomes:
--   'expired'    — no unexpired device with this code
--   'slow_down'  — polled within _min_interval_secs (last_poll NOT advanced)
--   'pending'    — created/bound but not yet approved
--   'denied'     — the request was denied
--   'approved'   — bound user_id; the caller mints a session + deletes the device
-------------------------------------------------------------------------------
create or replace function {{schema}}.poll_device
( _device_code text
, _min_interval_secs double precision default 5
)
returns table (status text, user_id uuid)
as $func$
declare
  _d record;
begin
  select d.* into _d
  from {{schema}}.device_authorization d
  where d.device_code = _device_code and d.expires_at > now();

  if not found then
    return query select 'expired'::text, null::uuid;
    return;
  end if;

  -- rate limit: polled too recently -> slow_down, without advancing last_poll
  if _d.last_poll is not null
     and extract(epoch from now() - _d.last_poll) < _min_interval_secs then
    return query select 'slow_down'::text, null::uuid;
    return;
  end if;

  update {{schema}}.device_authorization
  set last_poll = now()
  where device_code = _device_code;

  -- stored status passes straight through; user_id only when approved
  return query
    select _d.status, case when _d.status = 'approved' then _d.user_id else null::uuid end;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- delete_device  (cleanup after completion)
-------------------------------------------------------------------------------
create or replace function {{schema}}.delete_device(_device_code text)
returns bool
as $func$
  with d as
  (
    delete from {{schema}}.device_authorization where device_code = _device_code returning 1
  )
  select exists (select 1 from d)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- delete_expired_devices  (cron)
-------------------------------------------------------------------------------
create or replace function {{schema}}.delete_expired_devices()
returns bigint
as $func$
  with d as
  (
    delete from {{schema}}.device_authorization where expires_at <= now() returning 1
  )
  select count(*) from d
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
