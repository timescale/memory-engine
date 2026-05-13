-- Diagnose why semantic search returns no rows under app-equivalent RLS.
-- Required: schema, user_id. Optional: memory_id, semantic, emb, query_prefix.
-- If emb is omitted, this includes _embedding.sql to generate/load queries/emb.txt.

\ir _setup.sql
\ir _embedding.sql

\if :{?memory_id}
\else
\prompt 'memory_id to inspect: ' memory_id
\endif

\timing on

\echo Current execution context
:query_prefix
select
  current_user as current_user
, current_role as current_role
, current_setting('me.user_id', true) as me_user_id
, current_schema() as current_schema;

\echo Visible memory counts through RLS
:query_prefix
select
  count(*)::int as visible_rows
, count(embedding)::int as visible_embedded_rows
from :"schema".memory;

\echo Known memory row through RLS
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

\echo Distance for known memory row through RLS
:query_prefix
select
  id
, embedding is not null as has_embedding
, embedding <=> :'emb'::halfvec as distance
, (1 - (embedding <=> :'emb'::halfvec)) as score
from :"schema".memory
where id = :'memory_id'::uuid;

\echo Effective read tree_access rows
:query_prefix
select tree_path::text
from :"schema".tree_access(:'user_id'::uuid, 'read') as ta(tree_path)
order by tree_path::text
limit 100;

\ir _teardown.sql
