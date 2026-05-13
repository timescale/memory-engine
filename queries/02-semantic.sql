-- Semantic/HNSW search.
-- Required: schema, user_id. Provide emb or semantic. Optional: limit, emb_file, query_prefix.
-- Mirrors buildSemanticQuery without additional filters and without semanticThreshold.

\ir _setup.sql
\ir _embedding.sql

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
order by score desc, created_at desc
limit :limit;

\ir _teardown.sql
