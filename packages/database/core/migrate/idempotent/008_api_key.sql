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
-- Returns the member_id + api_key id + the member's owner_id (non-null when the
-- key-holder is an agent, null for a user) when valid; no rows otherwise. The
-- owner_id drives `~` home nesting for agents at the RPC boundary.
-------------------------------------------------------------------------------
-- Adding the `owner_id` output column changed the returns-table signature, which
-- create-or-replace cannot do. Drop the old definition only when it's still
-- present with that stale signature (no `owner_id` output column); when the
-- function is already current — or absent — skip the drop so it isn't churned
-- every migration run. The create-or-replace below then (re)creates it.
do $$ begin
  if exists
  (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = '{{schema}}'
    and p.proname = 'validate_api_key'
    and not ('owner_id' = any (coalesce(p.proargnames, array[]::text[])))
  ) then
    drop function {{schema}}.validate_api_key(text, text);
  end if;
end $$;
create or replace function {{schema}}.validate_api_key
( _lookup_id text
, _secret text -- hashed
)
returns table
( member_id uuid
, api_key_id uuid
, owner_id uuid
)
as $func$
  select k.member_id, k.id, p.owner_id
  from {{schema}}.api_key k
  inner join {{schema}}.principal p on p.id = k.member_id
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
