-- Semantic/HNSW search with ltree subtree filter.
-- Required: schema, user_id, tree. Provide emb or semantic. Optional: limit, query_prefix.
-- Mirrors buildSemanticQuery with common filters in app order: tree.

\ir _setup.sql
\ir _embedding.sql

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
, (1 - (embedding <=> :'emb'::halfvec)) as score
from :"schema".memory
where embedding is not null
  and (embedding <=> :'emb'::halfvec) < 1.0
  and tree <@ :'tree'::ltree
order by score desc, created_at desc
limit :limit;

\ir _teardown.sql
