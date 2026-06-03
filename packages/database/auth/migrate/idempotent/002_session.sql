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
  select s.id, u.id, u.email::text, u.name, s.expires_at
  from {{schema}}.sessions s
  inner join {{schema}}.users u on (u.id = s.user_id)
  where s.token_hash = _token_hash
    and s.expires_at > now()
$func$ language sql stable security invoker
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
