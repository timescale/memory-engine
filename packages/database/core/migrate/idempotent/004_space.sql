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
-- rename_space
-------------------------------------------------------------------------------
create or replace function {{schema}}.rename_space
( _slug text
, _name text
)
returns bool
as $func$
  with u as
  (
    update {{schema}}.space set name = _name where slug = _slug returning 1
  )
  select exists (select 1 from u)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- delete_space
-- Deletes the core.space row; FKs cascade its memberships, groups, grants, and
-- group memberships. The me_<slug> data schema is dropped separately by the
-- caller (DDL). Returns true if a space with this slug existed.
-------------------------------------------------------------------------------
create or replace function {{schema}}.delete_space
( _slug text
)
returns bool
as $func$
  with d as
  (
    delete from {{schema}}.space where slug = _slug returning 1
  )
  select exists (select 1 from d)
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
$func$ language sql stable strict rows 1 security invoker
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

-------------------------------------------------------------------------------
-- list_spaces_for_member
-- Spaces a member (user/agent) belongs to — i.e. has a direct principal_space
-- row. Group membership alone does NOT make you a space member, so a space
-- reached only through a group is not listed. `admin` is the effective
-- space-admin status (a direct admin row OR a direct member who belongs to an
-- admin group). Used by the user endpoint so a logged-in human can pick their
-- space.
-------------------------------------------------------------------------------
create or replace function {{schema}}.list_spaces_for_member
( _member_id uuid
)
returns table
( id uuid
, slug text
, name text
, language text
, admin bool
, created_at timestamptz
, updated_at timestamptz
)
as $func$
  -- Drive from principal_space (indexed by the member) and PK-join to space.
  select
    s.id
  , s.slug
  , s.name::text
  , s.language
  -- derived from is_principal_space_admin so it matches the authority gate
  -- (a direct member who belongs to an admin group shows admin=true)
  , {{schema}}.is_principal_space_admin(_member_id, s.id) as admin
  , s.created_at
  , s.updated_at
  from {{schema}}.principal_space ps
  inner join {{schema}}.space s on s.id = ps.space_id
  where ps.principal_id = _member_id
  order by s.created_at desc
$func$ language sql stable strict security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
