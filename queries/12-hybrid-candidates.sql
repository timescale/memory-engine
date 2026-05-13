-- Hybrid candidate queries: BM25 candidate query followed by semantic candidate query.
-- Required: schema, user_id, fulltext. Provide emb or semantic.
-- Optional: candidate_limit, query_prefix.
-- The app runs these two queries in parallel, fuses IDs in TypeScript, then fetches by ID.
-- psql runs them sequentially but keeps each query faithful to the app SQL.

\ir _setup.sql
\ir _embedding.sql

\if :{?fulltext}
\else
\prompt 'fulltext: ' fulltext
\endif

\timing on

\echo BM25 candidates
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
order by score desc, created_at desc
limit :candidate_limit;

\echo Semantic candidates
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
limit :candidate_limit;

\ir _teardown.sql
