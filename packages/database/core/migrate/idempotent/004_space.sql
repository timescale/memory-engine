-------------------------------------------------------------------------------
-- create_space
-------------------------------------------------------------------------------
create or replace function {{schema}}.create_space
( _slug text
, _name text
, _language text default 'english'
)
returns uuid
as $func$
  insert into {{schema}}.space (slug, name, language)
  values (_slug, _name, coalesce(_language, 'english'))
  returning id
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- get_space
-------------------------------------------------------------------------------
create or replace function {{schema}}.get_space
( _slug text
)
returns table
( id uuid
, slug text
, name text
, language text
, created_at timestamptz
, updated_at timestamptz
)
as $func$
  select s.id, s.slug, s.name::text, s.language, s.created_at, s.updated_at
  from {{schema}}.space s
  where s.slug = _slug
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- list_spaces
-- All spaces, newest first. Used by the embedding worker to discover the
-- me_<slug> data schemas to process.
-------------------------------------------------------------------------------
create or replace function {{schema}}.list_spaces()
returns table
( id uuid
, slug text
, name text
, language text
, created_at timestamptz
, updated_at timestamptz
)
as $func$
  select s.id, s.slug, s.name::text, s.language, s.created_at, s.updated_at
  from {{schema}}.space s
  order by s.created_at desc
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
