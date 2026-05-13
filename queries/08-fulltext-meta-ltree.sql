-- Full-text/BM25 search with JSONB metadata + ltree subtree filters.
-- Required: schema, user_id, fulltext, meta, tree. Optional: limit, query_prefix.
-- Mirrors buildBM25Query with common filters in app order: meta, tree.

\ir _setup.sql

\if :{?fulltext}
\else
\prompt 'fulltext: ' fulltext
\endif

\if :{?meta}
\else
\prompt 'meta json: ' meta
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
  and meta @> :'meta'::jsonb
  and tree <@ :'tree'::ltree
order by score desc, created_at desc
limit :limit;

\ir _teardown.sql
