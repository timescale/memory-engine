-------------------------------------------------------------------------------
-- Migration helper: drop a function whose signature no longer matches the target
--
-- `create or replace function` cannot change a function's return type (it raises
-- 42P13 "cannot change return type of existing function"), cannot rename an input
-- parameter (42P13 "cannot change name of input parameter"), and, when the
-- ARGUMENT types change, silently leaves the old overload behind. All three used
-- to be handled per-function with hand-written `drop function if exists (oldargs)`
-- lines and guarded `do $$ ... pg_proc check ... $$` blocks. This centralizes
-- that: the fn/endfn template block (see migrate/kit.ts `template`) brackets a
-- `create or replace function` with a call to
-- `drop_function_if_signature_differs(...)` before (drops a definition whose
-- signature differs, so the create can't hit 42P13 and stale overloads don't
-- linger) and `assert_function_signature(...)` after (fails loudly if the live
-- function doesn't match the header).
--
-- SIGNATURE = the ordered IN-parameter (name, type) pairs plus the result. The
-- fn/endfn header therefore spells each IN arg as `name type` (e.g.
-- `_tree_access jsonb`), NOT types-only — a parameter RENAME (same type) is a
-- 42P13 just like a type change, so the drop guard must see the target names to
-- know to drop first. Write types WITHOUT a typmod (`halfvec`, not
-- `halfvec(1536)`); the type is canonicalized via regtype regardless.
--
-- ASSUMES the function name is NOT intentionally overloaded (true for every
-- function this is used on). Under that assumption it can drop EVERY same-named
-- function whose signature differs from the target, which also sweeps away stale
-- overloads left by past argument changes. Do NOT use it for a deliberately
-- overloaded name (e.g. count_tree) — it would drop the sibling overloads.
--
-- Churn-free: when the live function already matches the target it is left
-- untouched, so the following create-or-replace just rebinds the body in place
-- (the oid is stable). Comparison is canonical: argument TYPES are matched by
-- OID (`pg_proc.proargtypes`), so `bool`/`boolean`, `int`/`integer`,
-- `float8`/`double precision`, and a typmod like `halfvec(1536)` vs `halfvec`
-- collapse to one OID; argument NAMES are matched literally against the live
-- IN-parameter names (`pg_proc.proargnames`, masked to IN/INOUT/VARIADIC modes);
-- the result is compared the way `pg_get_function_result` renders it. A
-- non-canonical target spec at worst drops + recreates once; it can never raise
-- 42P13.
--
-- Limitation: the TABLE(...) result parser splits columns on `,`, so a result
-- column whose type carries a comma in its modifier (e.g. `numeric(10,2)`) is not
-- supported. No tracked function returns such a column.
-------------------------------------------------------------------------------

-- Resolve a comma-separated `name type` argument list ('_a jsonb, _b uuid',
-- '_ids uuid[]', '' for none) to the space-separated type-OID string an oidvector
-- renders as — i.e. the form `pg_proc.proargtypes::text` takes — so the target and
-- the live IN-arg types compare as OIDs. The leading token of each arg is the
-- parameter NAME and is dropped here (it is compared separately, by name); the
-- remainder is the type (which may be multi-word, e.g. `timestamp with time
-- zone`). Order is preserved. (The param is named `_types` for historical reasons;
-- renaming it would itself trip the 42P13 this file guards against, and these
-- helpers are installed unguarded.)
create or replace function {{schema}}._arg_type_oids(_types text)
returns text
as $func$
  select coalesce(
    string_agg(
      btrim(substr(a, length(split_part(a, ' ', 1)) + 1))::regtype::oid::text
    , ' ' order by ord
    )
  , ''
  )
  from (
    select btrim(t) as a, ord
    from regexp_split_to_table(coalesce(_types, ''), ',') with ordinality as s(t, ord)
    where btrim(t) <> ''
  ) q
$func$ language sql stable
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-- Extract the ordered parameter NAMES from a `name type` argument list (the
-- leading whitespace-delimited token of each comma-separated arg). Returns a
-- text[] in declaration order ('{}' for no args). Compared against the live
-- IN-parameter names so a rename (which `create or replace function` cannot do
-- in place) forces a drop-and-recreate.
create or replace function {{schema}}._arg_names(_args text)
returns text[]
as $func$
  select coalesce(
    array_agg(split_part(btrim(t), ' ', 1) order by ord)
  , array[]::text[]
  )
  from regexp_split_to_table(coalesce(_args, ''), ',') with ordinality as s(t, ord)
  where btrim(t) <> ''
$func$ language sql stable
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-- The live IN-parameter names of a function, in declaration order. `proargnames`
-- carries every parameter name (IN and OUT/TABLE); we mask it to the IN-ish modes
-- (IN 'i', INOUT 'b', VARIADIC 'v') so TABLE result columns are excluded and the
-- list lines up with `proargtypes` / the target. A NULL `proargmodes` means every
-- parameter is IN. Returns '{}' for a no-arg (or unnamed) function.
create or replace function {{schema}}._in_arg_names(_oid oid)
returns text[]
as $func$
  select coalesce(
    array_agg(u.an order by u.ord)
      filter (where u.am is null or u.am in ('i', 'b', 'v'))
  , array[]::text[]
  )
  from pg_proc p
  cross join lateral unnest(
      coalesce(p.proargnames, array[]::text[])
    , coalesce(p.proargmodes, array[]::"char"[])
  ) with ordinality as u(an, am, ord)
  where p.oid = _oid
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

-- Drop any {{schema}}.<_name> whose (input arg types, input arg names, result)
-- differs from the target. See the header comment for the contract. Returns the
-- number of functions dropped (0 when the target already matches, or no such
-- function exists). The DROP targets each match by its own identity arguments
-- (which may include parameter names — valid in DROP FUNCTION).
create or replace function {{schema}}.drop_function_if_signature_differs
( _name text       -- unqualified function name within {{schema}}
, _arg_types text  -- target IN args, comma-separated `name type` pairs; '' for none
, _result text     -- target result: a type, 'setof <type>', or 'table(col type, ...)'
)
returns integer
as $func$
declare
  _want_args text := {{schema}}._arg_type_oids(_arg_types);
  _want_names text[] := {{schema}}._arg_names(_arg_types);
  _want_result text := {{schema}}._normalize_result(_result);
  _fn record;
  _dropped integer := 0;
begin
  for _fn in
    select p.oid as oid
         , p.proargtypes::text as arg_oids
         , pg_get_function_identity_arguments(p.oid) as ident
         , pg_get_function_result(p.oid) as result
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = '{{schema}}'
    and p.proname = _name
  loop
    if _fn.arg_oids is distinct from _want_args
       or {{schema}}._in_arg_names(_fn.oid) is distinct from _want_names
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
-- (canonical arg types + arg names + result); raise otherwise. The fn/endfn template block emits
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
  _want_names text[] := {{schema}}._arg_names(_arg_types);
  _want_result text := {{schema}}._normalize_result(_result);
  _total int := 0;
  _matching int := 0;
begin
  select count(*)
       , count(*) filter
         ( where p.proargtypes::text = _want_args
             and {{schema}}._in_arg_names(p.oid) is not distinct from _want_names
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
