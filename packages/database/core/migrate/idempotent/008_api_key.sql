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
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
