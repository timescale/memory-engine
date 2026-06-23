-------------------------------------------------------------------------------
-- Migration helper: drop a function whose signature no longer matches the target
--
-- `create or replace function` cannot change a function's return type (it raises
-- 42P13 "cannot change return type of existing function") and, when the ARGUMENT
-- types change, silently leaves the old overload behind. Both used to be handled
-- per-function with hand-written `drop function if exists (oldargs)` lines and
-- guarded `do $$ ... pg_proc check ... $$` blocks. This centralizes that: the
-- fn/endfn template block (see migrate/kit.ts `template`) brackets a
-- `create or replace function` with a call to
-- `drop_function_if_signature_differs(...)` before (drops a definition whose
-- signature differs, so the create can't hit 42P13 and stale overloads don't
-- linger) and `assert_function_signature(...)` after (fails loudly if the live
-- function doesn't match the header).
--
-- ASSUMES the function name is NOT intentionally overloaded (true for every
-- function this is used on). Under that assumption it can drop EVERY same-named
-- function whose signature differs from the target, which also sweeps away stale
-- overloads left by past argument changes. Do NOT use it for a deliberately
-- overloaded name (e.g. count_tree) — it would drop the sibling overloads.
--
-- Churn-free: when the live function already matches the target it is left
-- untouched, so the following create-or-replace just rebinds the body in place
-- (the oid is stable). Comparison is canonical: arguments are matched by type
-- OID (`pg_proc.proargtypes`), so `bool`/`boolean`, `int`/`integer`,
-- `float8`/`double precision`, and a typmod like `halfvec(1536)` vs `halfvec`
-- collapse to one OID; the result is compared the way `pg_get_function_result`
-- renders it. A non-canonical target spec at worst drops + recreates once; it can
-- never raise 42P13.
--
-- Limitation: the TABLE(...) result parser splits columns on `,`, so a result
-- column whose type carries a comma in its modifier (e.g. `numeric(10,2)`) is not
-- supported. No tracked function returns such a column.
-------------------------------------------------------------------------------

-- Resolve a comma-separated, types-only argument list ('jsonb, uuid', 'uuid[]',
-- '' for none) to the space-separated type-OID string an oidvector renders as —
-- i.e. the form `pg_proc.proargtypes::text` takes — so the target and the live
-- IN-arg types compare as OIDs. Order is preserved.
create or replace function {{schema}}._arg_type_oids(_types text)
returns text
as $func$
  select coalesce(
    string_agg((btrim(t)::regtype::oid)::text, ' ' order by ord)
  , ''
  )
  from regexp_split_to_table(coalesce(_types, ''), ',') with ordinality as s(t, ord)
  where btrim(t) <> ''
$func$ language sql stable
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-- Normalize a function result spec to the canonical text `pg_get_function_result`
-- produces: a scalar type, 'SETOF <type>', or 'TABLE(col type, ...)'. Element and
-- column types are canonicalized via regtype; the SETOF/TABLE keywords are
-- upper-cased to match. Applied to both the target and the live result so they
-- compare regardless of spelling.
create or replace function {{schema}}._normalize_result(_result text)
returns text
as $func$
declare
  _inner text;
  _col text;
  _nm text;
  _ty text;
  _cols text[] := array[]::text[];
begin
  if _result ~* '^\s*table\s*\(.*\)\s*$' then
    _inner := regexp_replace(_result, '^\s*table\s*\((.*)\)\s*$', '\1', 'is');
    foreach _col in array string_to_array(_inner, ',')
    loop
      _col := btrim(_col);
      if _col = '' then
        continue;
      end if;
      _nm := split_part(_col, ' ', 1);
      _ty := btrim(substr(_col, length(_nm) + 1));
      _cols := _cols || (_nm || ' ' || _ty::regtype::text);
    end loop;
    return 'TABLE(' || array_to_string(_cols, ', ') || ')';
  elsif _result ~* '^\s*setof\s+' then
    return 'SETOF ' || btrim(regexp_replace(_result, '^\s*setof\s+', '', 'is'))::regtype::text;
  else
    return btrim(_result)::regtype::text;
  end if;
end;
$func$ language plpgsql stable
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-- Drop any {{schema}}.<_name> whose (input arg types, result) differs from the
-- target. See the header comment for the contract. Returns the number of
-- functions dropped (0 when the target already matches, or no such function
-- exists). The DROP targets each match by its own identity arguments (which may
-- include parameter names — valid in DROP FUNCTION).
create or replace function {{schema}}.drop_function_if_signature_differs
( _name text       -- unqualified function name within {{schema}}
, _arg_types text  -- target IN-arg types, comma-separated (types only); '' for none
, _result text     -- target result: a type, 'setof <type>', or 'table(col type, ...)'
)
returns integer
as $func$
declare
  _want_args text := {{schema}}._arg_type_oids(_arg_types);
  _want_result text := {{schema}}._normalize_result(_result);
  _fn record;
  _dropped integer := 0;
begin
  for _fn in
    select p.proargtypes::text as arg_oids
         , pg_get_function_identity_arguments(p.oid) as ident
         , pg_get_function_result(p.oid) as result
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = '{{schema}}'
    and p.proname = _name
  loop
    if _fn.arg_oids is distinct from _want_args
       or {{schema}}._normalize_result(_fn.result) is distinct from _want_result
    then
      execute format('drop function {{schema}}.%I(%s)', _name, _fn.ident);
      _dropped := _dropped + 1;
    end if;
  end loop;
  return _dropped;
end;
$func$ language plpgsql volatile
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-- Assert that {{schema}}.<_name> is defined EXACTLY ONCE and matches the target
-- (canonical args + result); raise otherwise. The fn/endfn template block emits
-- this AFTER each `create or replace function`, so a mismatch between the block
-- header and the function the create actually builds is a hard failure on every
-- migration — including the fresh-schema migrations CI runs, where the pre-create
-- drop guard finds nothing to drop. That turns a header/definition drift from
-- silent per-boot churn into a loud, CI-visible error.
create or replace function {{schema}}.assert_function_signature
( _name text
, _arg_types text
, _result text
)
returns void
as $func$
declare
  _want_args text := {{schema}}._arg_type_oids(_arg_types);
  _want_result text := {{schema}}._normalize_result(_result);
  _total int := 0;
  _matching int := 0;
begin
  select count(*)
       , count(*) filter
         ( where p.proargtypes::text = _want_args
             and {{schema}}._normalize_result(pg_get_function_result(p.oid)) = _want_result
         )
    into _total, _matching
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = '{{schema}}'
  and p.proname = _name;

  if _total = 1 and _matching = 1 then
    return;
  end if;

  raise exception
    'function signature drift: {{schema}}.%(%) returns % — found % definition(s), % matching. Reconcile the fn block header with the create-or-replace.'
  , _name, _arg_types, _result, _total, _matching;
end;
$func$ language plpgsql stable
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
