-- Full-text/BM25 search with ltree subtree filter.
-- Required: schema, user_id, fulltext, tree. Optional: limit, query_prefix.
-- Mirrors buildBM25Query with common filters in app order: tree.

\ir _setup.sql

\if :{?fulltext}
\else
\prompt 'fulltext: ' fulltext
\endif

\if :{?tree}
\else
\prompt 'tree: ' tree
\endif

\timing on

:query_prefix
select
  id
, content
, meta
, tree::text
, temporal::text
, embedding is not null as has_embedding
, created_at
, created_by
, updated_at
, -(content <@> to_bm25query(:'fulltext', :'schema' || '.memory_content_bm25_idx')) as score
from :"schema".memory
where content <@> to_bm25query(:'fulltext', :'schema' || '.memory_content_bm25_idx') < 0
  and tree <@ :'tree'::ltree
order by score desc, created_at desc
limit :limit;

\ir _teardown.sql
