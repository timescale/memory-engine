-------------------------------------------------------------------------------
-- create_user
-- email_verified is set from the provider's verified-email flag by the caller.
-------------------------------------------------------------------------------
create or replace function {{schema}}.create_user
( _email text
, _name text
, _email_verified bool default false
, _image text default null
)
returns uuid
as $func$
  insert into {{schema}}.users (email, name, email_verified, image)
  values (_email, _name, coalesce(_email_verified, false), _image)
  returning id
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- get_user
-------------------------------------------------------------------------------
create or replace function {{schema}}.get_user(_id uuid)
returns table
( id uuid
, email text
, name text
, email_verified bool
, image text
, created_at timestamptz
, updated_at timestamptz
)
as $func$
  select u.id, u.email::text, u.name, u.email_verified, u.image, u.created_at, u.updated_at
  from {{schema}}.users u
  where u.id = _id
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- get_user_by_email (citext column -> case-insensitive match)
-------------------------------------------------------------------------------
create or replace function {{schema}}.get_user_by_email(_email text)
returns table
( id uuid
, email text
, name text
, email_verified bool
, image text
, created_at timestamptz
, updated_at timestamptz
)
as $func$
  select u.id, u.email::text, u.name, u.email_verified, u.image, u.created_at, u.updated_at
  from {{schema}}.users u
  where u.email = _email::citext -- compare as citext (case-insensitive); a text param would force text=text
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
