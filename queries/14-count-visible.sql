-- Minimal visible-row scan through RLS.
-- Required: schema, user_id. Optional: query_prefix.

\ir _setup.sql

\timing on

:query_prefix
select count(*)::int as count
from :"schema".memory;

\ir _teardown.sql
