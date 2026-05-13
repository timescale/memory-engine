-- Owner/admin diagnostic for auth, grants, and a known memory row.
-- Required: schema, user_id. Optional: memory_id, query_prefix.
-- This intentionally does NOT set role to me_ro, so run it with the fork owner/admin
-- connection. It is for diagnosing why app-equivalent RLS sees no rows.

\set ON_ERROR_STOP on
\pset pager off
\timing off

\if :{?schema}
\else
\prompt 'schema: ' schema
\endif

\if :{?user_id}
\else
\prompt 'user_id: ' user_id
\endif

\if :{?memory_id}
\else
\prompt 'memory_id to inspect: ' memory_id
\endif

\if :{?query_prefix}
\else
\set query_prefix --
\endif

begin;

select
  set_config('statement_timeout', '25s', true) as statement_timeout
, set_config('lock_timeout', '5s', true) as lock_timeout
, set_config('transaction_timeout', '30s', true) as transaction_timeout
, set_config('idle_in_transaction_session_timeout', '30s', true) as idle_timeout
\gset setup_

set local search_path to :"schema", public;

\timing on

\echo Owner/admin execution context
:query_prefix
select
  current_user as current_user
, current_role as current_role
, current_schema() as current_schema
, current_setting('me.user_id', true) as me_user_id;

\echo Memory table RLS flags and owner
:query_prefix
select
  n.nspname as schema
, c.relname as table_name
, pg_get_userbyid(c.relowner) as table_owner
, c.relrowsecurity as rls_enabled
, c.relforcerowsecurity as force_rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = :'schema'
  and c.relname = 'memory';

\echo Total memory counts as owner/admin
:query_prefix
select
  count(*)::int as total_rows
, count(embedding)::int as embedded_rows
from :"schema".memory;

\echo Known memory row as owner/admin
:query_prefix
select
  id
, tree::text
, embedding is not null as has_embedding
, created_at
, created_by
, left(content, 500) as content_prefix
from :"schema".memory
where id = :'memory_id'::uuid;

\echo Provided user by id
:query_prefix
select
  id
, name
, identity_id
, can_login
, superuser
, createrole
, created_at
from :"schema"."user"
where id = :'user_id'::uuid;

\echo Users whose identity_id equals provided user_id (common mix-up check)
:query_prefix
select
  id
, name
, identity_id
, can_login
, superuser
, createrole
, created_at
from :"schema"."user"
where identity_id = :'user_id'::uuid;

\echo Effective read tree_access for provided user_id
:query_prefix
select tree_path::text
from :"schema".tree_access(:'user_id'::uuid, 'read') as ta(tree_path)
order by tree_path::text
limit 100;

\echo Direct grants for provided user_id
:query_prefix
select
  g.id
, g.user_id
, u.name as user_name
, g.tree_path::text
, g.actions
, g.with_grant_option
, g.created_at
from :"schema".tree_grant g
join :"schema"."user" u on u.id = g.user_id
where g.user_id = :'user_id'::uuid
order by g.tree_path::text;

\echo Role memberships involving provided user_id
:query_prefix
select
  rm.role_id
, role_user.name as role_name
, rm.member_id
, member_user.name as member_name
, rm.with_admin_option
, rm.created_at
from :"schema".role_membership rm
join :"schema"."user" role_user on role_user.id = rm.role_id
join :"schema"."user" member_user on member_user.id = rm.member_id
where rm.role_id = :'user_id'::uuid
   or rm.member_id = :'user_id'::uuid
order by rm.created_at;

\echo All users summary
:query_prefix
select
  id
, name
, identity_id
, can_login
, superuser
, createrole
, created_at
from :"schema"."user"
order by superuser desc, can_login desc, created_at
limit 100;

\echo All grants summary
:query_prefix
select
  g.user_id
, u.name as user_name
, g.tree_path::text
, g.actions
, g.with_grant_option
, g.created_at
from :"schema".tree_grant g
join :"schema"."user" u on u.id = g.user_id
order by u.name, g.tree_path::text
limit 200;

\echo Users with read access to the known memory tree
:query_prefix
with target as (
  select tree
  from :"schema".memory
  where id = :'memory_id'::uuid
)
select
  u.id
, u.name
, u.identity_id
, u.superuser
, exists (
    select 1
    from :"schema".tree_access(u.id, 'read') as ta(tree_path)
    cross join target t
    where t.tree <@ ta.tree_path
  ) as can_read_known_memory
from :"schema"."user" u
order by can_read_known_memory desc, u.superuser desc, u.name
limit 100;

\timing off
rollback;
