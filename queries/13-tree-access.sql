-- Direct RLS helper expansion benchmark.
-- Required: schema, user_id. Optional: query_prefix.

\ir _setup.sql

\timing on

:query_prefix
select *
from :"schema".tree_access(:'user_id'::uuid, 'read');

\ir _teardown.sql
