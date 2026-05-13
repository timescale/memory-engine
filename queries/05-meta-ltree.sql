-- Filter-only JSONB metadata + ltree subtree query.
-- Required: schema, user_id, meta, tree. Optional: limit, order_direction, query_prefix.
-- Mirrors buildFilterQuery with common filters in app order: meta, tree.

\ir _setup.sql

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
, 1.0 as score
from :"schema".memory
where meta @> :'meta'::jsonb
  and tree <@ :'tree'::ltree
order by created_at :order_direction
limit :limit;

\ir _teardown.sql
