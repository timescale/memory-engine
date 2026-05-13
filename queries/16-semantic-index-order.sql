-- Semantic/HNSW search ordered by raw distance for pgvector index eligibility.
-- Required: schema, user_id. Provide emb or semantic. Optional: limit, query_prefix.
-- This is NOT exactly what the current app query does; it is the pgvector-recommended
-- order shape for using an ANN index: ORDER BY embedding <=> query LIMIT n.

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
order by embedding <=> :'emb'::halfvec, created_at desc
limit :limit;

\ir _teardown.sql
