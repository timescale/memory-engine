-- Filter-only ltree subtree query.
-- Required: schema, user_id, tree. Optional: limit, order_direction, query_prefix.
-- Mirrors buildFilterQuery with a plain ltree filter.

\ir _setup.sql

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
, 1.0 as score
from :"schema".memory
where tree <@ :'tree'::ltree
order by created_at :order_direction
limit :limit;

\ir _teardown.sql
