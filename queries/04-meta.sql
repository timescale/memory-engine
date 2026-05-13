-- Filter-only JSONB metadata containment query.
-- Required: schema, user_id, meta. Optional: limit, order_direction, query_prefix.
-- Mirrors buildFilterQuery with meta @> filter.

\ir _setup.sql

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
, 1.0 as score
from :"schema".memory
where meta @> :'meta'::jsonb
order by created_at :order_direction
limit :limit;

\ir _teardown.sql
