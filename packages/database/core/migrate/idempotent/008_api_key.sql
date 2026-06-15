-------------------------------------------------------------------------------
-- create_api_key
-- The caller generates the key (lookup_id + secret) and passes the *hashed*
-- secret; we never store the plaintext. Scoped to a member (user or agent).
-------------------------------------------------------------------------------
create or replace function {{schema}}.create_api_key
( _member_id uuid
, _lookup_id text
, _secret text -- already hashed by the caller
, _name text
, _expires_at timestamptz default null
)
returns uuid
as $func$
  insert into {{schema}}.api_key (member_id, lookup_id, secret, name, expires_at)
  values (_member_id, _lookup_id, _secret, _name, _expires_at)
  returning id
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- validate_api_key
-- Looks a key up by lookup_id, compares the hashed secret, and enforces expiry.
-- Returns the member_id + api_key id when valid; no rows otherwise.
-------------------------------------------------------------------------------
create or replace function {{schema}}.validate_api_key
( _lookup_id text
, _secret text -- hashed
)
returns table
( member_id uuid
, api_key_id uuid
)
as $func$
  select k.member_id, k.id
  from {{schema}}.api_key k
  where k.lookup_id = _lookup_id
  and k.secret = _secret
  and (k.expires_at is null or k.expires_at > now())
$func$ language sql stable strict rows 1 security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- get_api_key
-- Key metadata by id (never the secret).
-------------------------------------------------------------------------------
create or replace function {{schema}}.get_api_key
( _id uuid
)
returns table
( id uuid
, member_id uuid
, lookup_id text
, name text
, created_at timestamptz
, expires_at timestamptz
)
as $func$
  select k.id, k.member_id, k.lookup_id, k.name, k.created_at, k.expires_at
  from {{schema}}.api_key k
  where k.id = _id
$func$ language sql stable strict rows 1 security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- list_api_keys
-- A member's keys (never the secret), newest first.
-------------------------------------------------------------------------------
create or replace function {{schema}}.list_api_keys
( _member_id uuid
)
returns table
( id uuid
, member_id uuid
, lookup_id text
, name text
, created_at timestamptz
, expires_at timestamptz
)
as $func$
  select k.id, k.member_id, k.lookup_id, k.name, k.created_at, k.expires_at
  from {{schema}}.api_key k
  where k.member_id = _member_id
  order by k.created_at desc
$func$ language sql stable strict security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- delete_api_key
-- Hard-delete a key by id. Returns true if a row was deleted. (There is no
-- soft-revoke state; revoke and delete are the same operation.)
-------------------------------------------------------------------------------
create or replace function {{schema}}.delete_api_key
( _id uuid
)
returns bool
as $func$
  with d as
  (
    delete from {{schema}}.api_key
    where id = _id
    returning 1
  )
  select exists (select 1 from d)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
