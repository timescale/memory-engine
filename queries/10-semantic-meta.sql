-- Semantic/HNSW search with JSONB metadata filter.
-- Required: schema, user_id, meta. Provide emb or semantic. Optional: limit, emb_file, query_prefix.
-- Mirrors buildSemanticQuery with common filters in app order: meta.

\ir _setup.sql
\ir _embedding.sql

\if :{?meta}
\else
\prompt 'meta json: ' meta
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
  and meta @> :'meta'::jsonb
order by score desc, created_at desc
limit :limit;

\ir _teardown.sql
