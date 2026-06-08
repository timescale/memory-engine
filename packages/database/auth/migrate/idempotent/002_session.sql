-------------------------------------------------------------------------------
-- create_session
-- The caller generates the token and passes its hash (sha256); the plaintext
-- token is never stored.
-------------------------------------------------------------------------------
create or replace function {{schema}}.create_session
( _user_id uuid
, _token_hash bytea
, _expires_at timestamptz
)
returns uuid
as $func$
  insert into {{schema}}.sessions (user_id, token_hash, expires_at)
  values (_user_id, _token_hash, _expires_at)
  returning id
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- validate_session
-- Looks up an unexpired session by token hash and returns the session + its
-- user. No rows if missing or expired.
--
-- Rolling session (better-auth model): on a valid lookup the expiry slides
-- forward to now + 7 days, but at most once per day — only when the remaining
-- lifetime has dropped below (window - updateAge) = 6 days. So an actively-used
-- session never expires, an idle one lapses 7 days after last use, and the hot
-- path writes at most ~once/day/session (the function is therefore volatile).
-- No absolute cap, matching better-auth's defaults (expiresIn=7d, updateAge=1d).
-------------------------------------------------------------------------------
create or replace function {{schema}}.validate_session(_token_hash bytea)
returns table
( session_id uuid
, user_id uuid
, email text
, name text
, expires_at timestamptz
)
as $func$
  with valid as
  (
    select s.id, s.user_id, s.expires_at
    from {{schema}}.sessions s
    where s.token_hash = _token_hash
      and s.expires_at > now()
  )
  , bumped as
  (
    update {{schema}}.sessions s
       set expires_at = now() + interval '7 days'  -- window (expiresIn)
      from valid v
     where s.id = v.id
       and v.expires_at < now() + interval '6 days' -- throttle: window - updateAge (1d)
    returning s.id, s.expires_at
  )
  select v.id, u.id, u.email::text, u.name
       , coalesce(b.expires_at, v.expires_at) as expires_at
  from valid v
  inner join {{schema}}.users u on (u.id = v.user_id)
  left join bumped b on (b.id = v.id)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- delete_session
-------------------------------------------------------------------------------
create or replace function {{schema}}.delete_session(_id uuid)
returns bool
as $func$
  with d as
  (
    delete from {{schema}}.sessions where id = _id returning 1
  )
  select exists (select 1 from d)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- delete_sessions_by_user (revoke all)
-------------------------------------------------------------------------------
create or replace function {{schema}}.delete_sessions_by_user(_user_id uuid)
returns bigint
as $func$
  with d as
  (
    delete from {{schema}}.sessions where user_id = _user_id returning 1
  )
  select count(*) from d
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- cleanup_expired_sessions (cron)
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
