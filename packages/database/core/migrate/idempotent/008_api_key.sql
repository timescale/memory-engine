-------------------------------------------------------------------------------
-- create_api_key
-- The caller generates the key (lookup_id + secret) and passes the *hashed*
-- secret; we never store the plaintext. `_access` is null for an unrestricted
-- key, otherwise it is a non-empty JSON array of canonical space declarations.
-------------------------------------------------------------------------------
{{fn create_api_key(_member_id uuid, _lookup_id text, _secret text, _name text, _expires_at timestamptz, _access jsonb) returns uuid}}
create or replace function {{schema}}.create_api_key
( _member_id uuid
, _lookup_id text
, _secret text -- already hashed by the caller
, _name text
, _expires_at timestamptz default null
, _access jsonb default null
)
returns uuid
as $func$
  declare
    _key_id uuid;
    _declaration jsonb;
    _space_id uuid;
    _grants jsonb;
  begin
    if _access is not null
      and
      (
        jsonb_typeof(_access) <> 'array'
        or jsonb_array_length(_access) = 0
      )
    then
      raise exception 'restricted API key access must be a non-empty array'
      using errcode = '22023';
    end if;

    insert into {{schema}}.api_key
    ( member_id
    , lookup_id
    , secret
    , name
    , expires_at
    , restricted
    )
    values
    ( _member_id
    , _lookup_id
    , _secret
    , _name
    , _expires_at
    , _access is not null
    )
    returning id into _key_id;

    if _access is null then
      return _key_id;
    end if;

    for _declaration in select value from jsonb_array_elements(_access)
    loop
      if jsonb_typeof(_declaration) <> 'object'
        or jsonb_typeof(_declaration -> 'space_id') <> 'string'
      then
        raise exception 'API key access declarations require a string space_id'
        using errcode = '22023';
      end if;

      if _declaration ? 'space_admin'
        and jsonb_typeof(_declaration -> 'space_admin') <> 'boolean'
      then
        raise exception 'API key declaration space_admin must be a boolean'
        using errcode = '22023';
      end if;

      _grants := coalesce(_declaration -> 'grants', '[]'::jsonb);
      if jsonb_typeof(_grants) <> 'array' then
        raise exception 'API key declaration grants must be an array'
        using errcode = '22023';
      end if;
      if exists
      (
        select 1
        from jsonb_array_elements(_grants) grant_row
        where jsonb_typeof(grant_row) <> 'object'
          or jsonb_typeof(grant_row -> 'tree_path') <> 'string'
          or jsonb_typeof(grant_row -> 'access') <> 'number'
      ) then
        raise exception 'API key grants require string tree_path and numeric access'
        using errcode = '22023';
      end if;

      _space_id := (_declaration ->> 'space_id')::uuid;
      if not exists
      (
        select 1
        from {{schema}}.principal_space ps
        where ps.principal_id = _member_id
        and ps.space_id = _space_id
      ) then
        raise exception 'API key holder % is not a direct member of declared space %', _member_id, _space_id
        using errcode = '23514';
      end if;
      insert into {{schema}}.api_key_space_access
      ( api_key_id
      , space_id
      , space_admin
      )
      values
      ( _key_id
      , _space_id
      , coalesce((_declaration ->> 'space_admin')::boolean, false)
      );

      insert into {{schema}}.api_key_tree_access
      ( api_key_id
      , space_id
      , tree_path
      , access
      )
      select
        _key_id
      , _space_id
      , (grant_row ->> 'tree_path')::ltree
      , (grant_row ->> 'access')::int
      from jsonb_array_elements(_grants) grant_row;
    end loop;

    return _key_id;
  end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

-------------------------------------------------------------------------------
-- validate_api_key
-- Looks a key up by lookup_id, compares the hashed secret, and enforces expiry.
-- Returns the member_id + api_key id + the member's kind + name when valid; no
-- rows otherwise. Kind/name let the auth middleware skip a second principal
-- lookup per request (it already joins principal here).
-------------------------------------------------------------------------------
-- validate_api_key's returns-table has grown output columns several times — a
-- change create-or-replace cannot make. The fn block drops a
-- stale-signatured definition before the create and asserts the result after.
{{fn validate_api_key(_lookup_id text, _secret text) returns table(member_id uuid, api_key_id uuid, kind text, name text, api_key_name text, restricted bool)}}
create or replace function {{schema}}.validate_api_key
( _lookup_id text
, _secret text -- hashed
)
returns table
( member_id uuid
, api_key_id uuid
, kind text
, name text
, api_key_name text
, restricted bool
)
as $func$
  select k.member_id, k.id, p.kind, p.name::text, k.name, k.restricted
  from {{schema}}.api_key k
  inner join {{schema}}.principal p on p.id = k.member_id
  where k.lookup_id = _lookup_id
  and k.secret = _secret
  and (k.expires_at is null or k.expires_at > now())
$func$ language sql stable strict rows 1 security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

-------------------------------------------------------------------------------
-- get_api_key
-- Key metadata by id (never the secret).
-------------------------------------------------------------------------------
{{fn get_api_key(_id uuid) returns table(id uuid, member_id uuid, lookup_id text, name text, restricted bool, created_at timestamptz, expires_at timestamptz, last_used_on date)}}
create or replace function {{schema}}.get_api_key
( _id uuid
)
returns table
( id uuid
, member_id uuid
, lookup_id text
, name text
, restricted bool
, created_at timestamptz
, expires_at timestamptz
, last_used_on date
)
as $func$
  select k.id, k.member_id, k.lookup_id, k.name, k.restricted
       , k.created_at, k.expires_at, k.last_used_on
  from {{schema}}.api_key k
  where k.id = _id
$func$ language sql stable strict rows 1 security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

-------------------------------------------------------------------------------
-- list_api_keys
-- A member's keys (never the secret), newest first.
-------------------------------------------------------------------------------
{{fn list_api_keys(_member_id uuid) returns table(id uuid, member_id uuid, lookup_id text, name text, restricted bool, created_at timestamptz, expires_at timestamptz, last_used_on date)}}
create or replace function {{schema}}.list_api_keys
( _member_id uuid
)
returns table
( id uuid
, member_id uuid
, lookup_id text
, name text
, restricted bool
, created_at timestamptz
, expires_at timestamptz
, last_used_on date
)
as $func$
  select k.id, k.member_id, k.lookup_id, k.name, k.restricted
       , k.created_at, k.expires_at, k.last_used_on
  from {{schema}}.api_key k
  where k.member_id = _member_id
  order by k.created_at desc
$func$ language sql stable strict security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

-------------------------------------------------------------------------------
-- list_api_key_access
-- Restricted declarations for one key. Empty grants are significant: they mean
-- the declaration permits the holder's normal effective tree access in its
-- named space.
-------------------------------------------------------------------------------
{{fn list_api_key_access(_api_key_id uuid) returns table(space_id uuid, slug text, space_admin bool, grants jsonb)}}
create or replace function {{schema}}.list_api_key_access
( _api_key_id uuid
)
returns table
( space_id uuid
, slug text
, space_admin bool
, grants jsonb
)
as $func$
  select
    a.space_id
  , s.slug
  , a.space_admin
  , coalesce
    (
      (
        select jsonb_agg
        (
          jsonb_build_object
          ( 'tree_path', g.tree_path::text
          , 'access', g.access
          )
          order by g.tree_path, g.access
        )
        from {{schema}}.api_key_tree_access g
        where g.api_key_id = a.api_key_id
        and g.space_id = a.space_id
      )
    , '[]'::jsonb
    )
  from {{schema}}.api_key_space_access a
  inner join {{schema}}.space s on s.id = a.space_id
  where a.api_key_id = _api_key_id
  order by s.created_at desc
$func$ language sql stable strict security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

-------------------------------------------------------------------------------
-- _enforce_api_key_restriction_invariants
-- Scope rows are allowed only for restricted keys. Reassigning a scoped key's
-- holder would bypass the service-account native-space invariant, so it is
-- forbidden as well.
-------------------------------------------------------------------------------
create or replace function {{schema}}._enforce_api_key_restriction_invariants()
returns trigger
as $func$
begin
  if not new.restricted
    and exists
    (
      select 1
      from {{schema}}.api_key_space_access a
      where a.api_key_id = new.id
    )
  then
    raise exception 'API key % cannot become unrestricted while it has access declarations', new.id
    using errcode = '23514';
  end if;

  if new.member_id is distinct from old.member_id
    and exists
    (
      select 1
      from {{schema}}.api_key_space_access a
      where a.api_key_id = new.id
    )
  then
    raise exception 'cannot reassign scoped API key % to another principal', new.id
    using errcode = '23514';
  end if;

  return new;
end;
$func$ language plpgsql
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- _enforce_api_key_space_access_invariants
-- Only user and service-account keys may carry declarations. A service account
-- is native to one space, so every one of its declarations must name that space.
-------------------------------------------------------------------------------
create or replace function {{schema}}._enforce_api_key_space_access_invariants()
returns trigger
as $func$
declare
  _restricted boolean;
  _kind text;
  _native_space_id uuid;
begin
  select k.restricted, p.kind, p.space_id
    into _restricted, _kind, _native_space_id
  from {{schema}}.api_key k
  inner join {{schema}}.principal p on p.id = k.member_id
  where k.id = new.api_key_id;

  if not found then
    raise exception 'API key % does not exist', new.api_key_id
    using errcode = '23503';
  end if;
  if not _restricted then
    raise exception 'API key % must be restricted before adding access declarations', new.api_key_id
    using errcode = '23514';
  end if;
  if _kind not in ('u', 's') then
    raise exception 'API key % belongs to a principal that cannot carry access declarations', new.api_key_id
    using errcode = '23514';
  end if;
  if _kind = 's' and new.space_id is distinct from _native_space_id then
    raise exception 'service-account API key % can declare access only in its native space', new.api_key_id
    using errcode = '23514';
  end if;

  return new;
end;
$func$ language plpgsql
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

do $$ begin
  if not exists
  (
    select 1 from pg_trigger
    where tgrelid = '{{schema}}.api_key'::regclass
    and tgname = 'api_key_restriction_invariants'
  ) then
    create trigger api_key_restriction_invariants
    before update of restricted, member_id on {{schema}}.api_key
    for each row
    execute function {{schema}}._enforce_api_key_restriction_invariants();
  end if;
end $$;

do $$ begin
  if not exists
  (
    select 1 from pg_trigger
    where tgrelid = '{{schema}}.api_key_space_access'::regclass
    and tgname = 'api_key_space_access_invariants'
  ) then
    create trigger api_key_space_access_invariants
    before insert or update on {{schema}}.api_key_space_access
    for each row
    execute function {{schema}}._enforce_api_key_space_access_invariants();
  end if;
end $$;

-------------------------------------------------------------------------------
-- touch_api_key
-- Best-effort day-level usage tracking. Validation stays read-only; callers touch
-- after a key authenticates. The predicate keeps row churn to one update per day.
-------------------------------------------------------------------------------
create or replace function {{schema}}.touch_api_key
( _id uuid
, _used_on date
)
returns bool
as $func$
  with updated as
  (
    update {{schema}}.api_key
    set last_used_on = _used_on
    where id = _id
      and (last_used_on is null or last_used_on < _used_on)
    returning 1
  )
  select exists (select 1 from updated)
$func$ language sql volatile strict security invoker
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
