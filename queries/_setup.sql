\set ON_ERROR_STOP on
\pset pager off
\timing off

-- Shared app-equivalent transaction setup.
-- Required: schema, user_id. Optional: app_role, limit, candidate_limit,
-- statement_timeout, lock_timeout, transaction_timeout, idle_timeout,
-- order_direction, query_prefix.

\if :{?schema}
\else
\prompt 'schema: ' schema
\endif

\if :{?user_id}
\else
\prompt 'user_id: ' user_id
\endif

\if :{?app_role}
\else
\set app_role me_ro
\endif

\if :{?limit}
\else
\set limit 10
\endif

\if :{?candidate_limit}
\else
\set candidate_limit 30
\endif

\if :{?statement_timeout}
\else
\set statement_timeout 25s
\endif

\if :{?lock_timeout}
\else
\set lock_timeout 5s
\endif

\if :{?transaction_timeout}
\else
\set transaction_timeout 30s
\endif

\if :{?idle_timeout}
\else
\set idle_timeout 30s
\endif

\if :{?order_direction}
\else
\set order_direction DESC
\endif

\if :{?query_prefix}
\else
\set query_prefix --
\endif

begin;

select
  set_config('statement_timeout', :'statement_timeout', true) as statement_timeout
, set_config('lock_timeout', :'lock_timeout', true) as lock_timeout
, set_config('transaction_timeout', :'transaction_timeout', true) as transaction_timeout
, set_config('idle_in_transaction_session_timeout', :'idle_timeout', true) as idle_timeout
\gset setup_

set local search_path to :"schema", public;
set local role :app_role;

select set_config('me.user_id', :'user_id', true) as user_id
\gset setup_
