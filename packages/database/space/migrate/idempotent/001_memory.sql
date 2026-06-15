-------------------------------------------------------------------------------
-- memory triggers
-------------------------------------------------------------------------------
create or replace function {{schema}}.memory_before_update()
returns trigger
as $func$
begin
  -- always update the timestamp
  new.updated_at = pg_catalog.now();

  -- content changed -> new embedding needs to be generated
  if old.content is distinct from new.content
     and old.embedding is not distinct from new.embedding
  then
    new.embedding = null;
    new.embedding_version = old.embedding_version operator(pg_catalog.+) 1;
  end if;

  return new;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp -- public required for pgvector's `is not distinct from`
;

create or replace trigger memory_before_update_trg
before update on {{schema}}.memory
for each row
execute function {{schema}}.memory_before_update();

-------------------------------------------------------------------------------
-- tree_access
-------------------------------------------------------------------------------
create or replace function {{schema}}.tree_access(_tree_access jsonb)
returns table
( tree_path ltree
, access int
)
as $func$
  select
    x.tree_path
  , x.access
  from jsonb_to_recordset(_tree_access) x(tree_path ltree, access int)
$func$ language sql immutable strict security invoker
;

-------------------------------------------------------------------------------
-- has_tree_access
-------------------------------------------------------------------------------
create or replace function {{schema}}.has_tree_access
( _tree_access jsonb
, _tree_path ltree
, _access int
)
returns bool
as $func$
  select exists
  (
    select 1
    from {{schema}}.tree_access(_tree_access) x
    where x.tree_path @> _tree_path
    and x.access >= _access
  )
$func$ language sql immutable strict security invoker
;

-------------------------------------------------------------------------------
-- get memory
-------------------------------------------------------------------------------
create or replace function {{schema}}.get_memory
( _tree_access jsonb
, _id uuid
)
returns table
( id uuid
, tree ltree
, meta jsonb
, temporal tstzrange
, content text
, created_at timestamptz
, updated_at timestamptz
, has_embedding bool
)
as $func$
  select
    m.id
  , m.tree
  , m.meta
  , m.temporal
  , m.content
  , m.created_at
  , m.updated_at
  , m.embedding is not null
  from {{schema}}.memory m
  where m.id = _id
  and {{schema}}.has_tree_access(_tree_access, m.tree, 1)
$func$ language sql stable strict rows 1 security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- batch create memory
--
-- The canonical memory insert: one set-based statement for a whole batch
-- (create_memory below is a one-row wrapper). Parallel arrays, aligned by
-- position, carry the rows. Per-row, on a duplicate explicit id the outcome
-- depends on _replace_if_meta_differs:
--   - null (default): skip — the existing row is left untouched.
--   - a meta key name: the existing row is REPLACED (tree/meta/temporal/
--     content) when its meta->>key value differs from the new record's, and
--     skipped when it matches. Deterministic-id importers use this to push
--     re-renders by bumping a version value in meta (importer_version).
--     The replace arm additionally requires write access on the EXISTING
--     row's tree; without it the row is silently skipped (not raised, unlike
--     patch_memory) so one inaccessible row can't fail a whole batch.
--
-- Returns one row (id, inserted) per insert/replace — inserted distinguishes
-- a fresh insert (true, xmax = 0) from a replace (false); skipped rows are
-- absent. The target-tree access check is all-or-nothing up front (one bad
-- row raises before anything is written), and an explicit id repeated WITHIN
-- the batch collapses to its first occurrence (a single INSERT cannot touch
-- the same row twice); later occurrences are skipped.
--
-- Embedding columns are never set here: the update triggers invalidate and
-- re-enqueue the embedding only when content actually changed, so a
-- meta-only replace does not re-embed.
-------------------------------------------------------------------------------
create or replace function {{schema}}.batch_create_memory
( _tree_access jsonb
, _ids uuid[]                 -- null elements get a generated uuidv7
, _trees ltree[]
, _contents text[]
, _metas jsonb                -- json ARRAY of meta objects; null elements default to '{}'
, _temporals tstzrange[]
, _replace_if_meta_differs text default null
)
returns table (id uuid, inserted boolean)
as $func$
-- The out columns (id, inserted) shadow table columns inside the body; the
-- body never reads them as variables, so resolve ambiguity to the columns.
#variable_conflict use_column
begin
  -- _metas is one jsonb array (not jsonb[]): drivers pass json values
  -- reliably (sql.json), where a jsonb[] parameter invites double-encoded
  -- string scalars. Elements align with the arrays by position.
  if jsonb_typeof(_metas) is distinct from 'array'
     or cardinality(_ids) is distinct from cardinality(_trees)
     or cardinality(_ids) is distinct from cardinality(_contents)
     or cardinality(_ids) is distinct from jsonb_array_length(_metas)
     or cardinality(_ids) is distinct from cardinality(_temporals)
  then
    raise exception 'batch arrays must have equal lengths'
      using errcode = 'invalid_parameter_value';
  end if;

  if exists
  (
    select 1
    from unnest(_trees) t(tree)
    where not {{schema}}.has_tree_access(_tree_access, t.tree, 2)
  ) then
    raise exception 'insufficient tree access'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  with r as
  (
    select
      coalesce(u.id, uuidv7()) as id
    , u.tree
    , coalesce(nullif(e.meta, 'null'::jsonb), '{}'::jsonb) as meta
    , u.temporal
    , u.content
    , u.ord
    from unnest(_ids, _trees, _contents, _temporals)
         with ordinality u(id, tree, content, temporal, ord)
    join jsonb_array_elements(_metas) with ordinality e(meta, ord)
      on e.ord = u.ord
  )
  , d as
  (
    -- First occurrence wins when a batch repeats an explicit id.
    select distinct on (r.id) r.*
    from r
    order by r.id, r.ord
  )
  insert into {{schema}}.memory as m
  ( id
  , tree
  , meta
  , temporal
  , content
  )
  select d.id, d.tree, d.meta, d.temporal, d.content
  from d
  on conflict (id) do update set
    tree = excluded.tree
  , meta = excluded.meta
  , temporal = excluded.temporal
  , content = excluded.content
  where _replace_if_meta_differs is not null
  and m.meta->>_replace_if_meta_differs
      is distinct from excluded.meta->>_replace_if_meta_differs
  and {{schema}}.has_tree_access(_tree_access, m.tree, 2)
  returning m.id, (m.xmax = 0)
  ;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- create memory
--
-- One-row wrapper over batch_create_memory — see there for the conflict
-- semantics (insert / replace-if-meta-differs / skip) and the return shape.
--
-- The drop covers the pre-upsert 6-arg signature — without it, create would
-- add an ambiguous overload (and the return type changed). No-op on re-runs.
-------------------------------------------------------------------------------
drop function if exists {{schema}}.create_memory(jsonb, ltree, text, uuid, jsonb, tstzrange);
create or replace function {{schema}}.create_memory
( _tree_access jsonb
, _tree ltree
, _content text
, _id uuid default null
, _meta jsonb default '{}'
, _temporal tstzrange default null
, _replace_if_meta_differs text default null
)
returns table (id uuid, inserted boolean)
as $func$
  select b.id, b.inserted
  from {{schema}}.batch_create_memory(
    _tree_access,
    array[_id]::uuid[],
    array[_tree],
    array[_content],
    jsonb_build_array(coalesce(_meta, '{}'::jsonb)),
    array[_temporal],
    _replace_if_meta_differs
  ) b;
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- patch memory
-------------------------------------------------------------------------------
create or replace function {{schema}}.patch_memory
( _tree_access jsonb
, _id uuid
, _patch jsonb
)
returns bool
as $func$
declare
  _src ltree;
  _dst ltree;
  _ok bool;
begin
  -- at least one valid field must be present
  select count(*) filter (where k in ('meta', 'tree', 'temporal', 'content')) > 0
  into strict _ok
  from jsonb_each(_patch) o(k, v)
  ;

  if not _ok then
    raise exception 'no valid patch fields found'
      using errcode = 'invalid_parameter_value';
  end if;

  _dst = (_patch->>'tree')::ltree;

  -- cannot set tree to null
  if _patch ? 'tree' and _dst is null then
    raise exception 'tree cannot be set to null'
      using errcode = 'invalid_parameter_value';
  end if;

  -- find the existing memory and get it's tree
  select m.tree into _src
  from {{schema}}.memory m
  where m.id = _id
  for update -- don't let anyone "move" the memory while we're working on it
  ;

  if not found then
    return false;
  end if;

  with a as materialized
  (
    select a.tree_path, a.access
    from {{schema}}.tree_access(_tree_access) a
  )
  select
    exists
    (
      select 1
      from a
      where a.tree_path @> _src
      and a.access >= 2
    )
    and
    (
      _dst is null
      or _src @> _dst
      or exists
      (
        select 1
        from a
        where a.tree_path @> _dst
        and a.access >= 2
      )
    )
  into strict _ok
  ;

  if not _ok then
    raise exception 'insufficient tree access'
      using errcode = 'insufficient_privilege';
  end if;

  update {{schema}}.memory m set
    tree = case when _patch ? 'tree' then (_patch->>'tree')::ltree else m.tree end
  , meta = case when _patch ? 'meta' then _patch->'meta' else m.meta end
  , temporal = case when _patch ? 'temporal' then (_patch->>'temporal')::tstzrange else m.temporal end
  , content = case when _patch ? 'content' then _patch->>'content' else m.content end
  where id = _id
  returning id into _id
  ;

  return _id is not null;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- move tree
-------------------------------------------------------------------------------
create or replace function {{schema}}.move_tree
( _tree_access jsonb
, _src ltree
, _dst ltree
, _dry_run bool default false
)
returns bigint
as $func$
declare
  _has_src bool;
  _has_dst bool;
  _moved bigint;
begin
  -- must have read/write on _src
  -- must have read/write on _dst
  with a as materialized
  (
    select a.tree_path, a.access
    from {{schema}}.tree_access(_tree_access) a
  )
  select
    exists
    (
      select 1
      from a
      where a.tree_path @> _src
      and a.access >= 2
    )
  , exists
    (
      select 1
      from a
      where a.tree_path @> _dst
      and a.access >= 2
    )
  into strict _has_src, _has_dst
  ;

  if not _has_src then
    raise exception 'insufficient tree access'
      using errcode = 'insufficient_privilege';
  end if;

  if not _has_dst then
    raise exception 'insufficient tree access'
      using errcode = 'insufficient_privilege';
  end if;

  with x as
  (
    select m.id
    from {{schema}}.memory m
    where _src @> m.tree
  )
  , u as
  (
    update {{schema}}.memory m
    set tree =
      case
        when nlevel(m.tree) = nlevel(_src) then _dst
        else _dst || subpath(m.tree, nlevel(_src), nlevel(m.tree) - nlevel(_src))
      end
    from x
    where m.id = x.id
    and not _dry_run
  )
  select count(*) into strict _moved
  from x
  ;
  return _moved;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- copy tree
-------------------------------------------------------------------------------
create or replace function {{schema}}.copy_tree
( _tree_access jsonb
, _src ltree
, _dst ltree
, _dry_run bool default false
)
returns bigint
as $func$
declare
  _has_src bool;
  _has_dst bool;
  _copied bigint;
begin
  -- must have read on _src
  -- must have read/write on _dst
  with a as materialized
  (
    select a.tree_path, a.access
    from {{schema}}.tree_access(_tree_access) a
  )
  select
    exists
    (
      select 1
      from a
      where a.tree_path @> _src
      and a.access >= 1
    )
  , exists
    (
      select 1
      from a
      where a.tree_path @> _dst
      and a.access >= 2
    )
  into strict _has_src, _has_dst
  ;

  if not _has_src then
    raise exception 'insufficient tree access'
      using errcode = 'insufficient_privilege';
  end if;

  if not _has_dst then
    raise exception 'insufficient tree access'
      using errcode = 'insufficient_privilege';
  end if;

  with m as
  (
    select m.*
    from {{schema}}.memory m
    where _src @> m.tree
  )
  , i as
  (
    insert into {{schema}}.memory
    ( meta
    , tree
    , temporal
    , content
    , embedding
    , embedding_version
    )
    select
      m.meta
    , case
        when nlevel(m.tree) = nlevel(_src) then _dst
        else _dst || subpath(m.tree, nlevel(_src), nlevel(m.tree) - nlevel(_src))
      end as dst
    , m.temporal
    , m.content
    , m.embedding
    , m.embedding_version
    from m
    where not _dry_run
  )
  select count(*) into strict _copied
  from m
  ;

  return _copied;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- delete memory
-------------------------------------------------------------------------------
create or replace function {{schema}}.delete_memory
( _tree_access jsonb
, _id uuid
)
returns bool
as $func$
declare
  _tree ltree;
begin
  select m.tree into _tree
  from {{schema}}.memory m
  where m.id = _id
  for update
  ;

  if not found then
    return false;
  end if;

  if not {{schema}}.has_tree_access(_tree_access, _tree, 2) then
    raise exception 'insufficient tree access'
      using errcode = 'insufficient_privilege';
  end if;

  delete from {{schema}}.memory
  where id = _id
  ;
  return found;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- delete tree
-------------------------------------------------------------------------------
create or replace function {{schema}}.delete_tree
( _tree_access jsonb
, _tree ltree
, _dry_run bool default false
)
returns bigint
as $func$
declare
  _has_access bool;
  _deleted bigint;
begin
  -- must have read/write on _tree
  select exists
  (
    select 1
    from {{schema}}.tree_access(_tree_access) a
    where a.tree_path @> _tree
    and a.access >= 2
  )
  into strict _has_access
  ;

  if not _has_access then
    raise exception 'insufficient tree access'
      using errcode = 'insufficient_privilege';
  end if;

  if _dry_run then
    select count(*) into strict _deleted
    from {{schema}}.memory m
    where _tree @> m.tree
    ;
  else
    with d as
    (
      delete from {{schema}}.memory m
      where _tree @> m.tree
      returning id
    )
    select count(*) into strict _deleted
    from d
    ;
  end if;

  return _deleted;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- count tree
-------------------------------------------------------------------------------
create or replace function {{schema}}.count_tree
( _tree_access jsonb
, _tree ltree
, _access int4
)
returns bigint
as $func$
  with x as materialized
  (
    select a.tree_path
    from {{schema}}.tree_access(_tree_access) a
    where a.access >= _access
  )
  select count(*)
  from {{schema}}.memory m
  where _tree @> m.tree
  and exists
  (
    select 1
    from x
    where x.tree_path @> m.tree
  )
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- count tree
-------------------------------------------------------------------------------
create or replace function {{schema}}.count_tree
( _tree_access jsonb
, _query lquery
, _access int4
)
returns bigint
as $func$
  with x as materialized
  (
    select a.tree_path
    from {{schema}}.tree_access(_tree_access) a
    where a.access >= _access
  )
  select count(*)
  from {{schema}}.memory m
  where m.tree ~ _query
  and exists
  (
    select 1
    from x
    where x.tree_path @> m.tree
  )
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- count tree
-------------------------------------------------------------------------------
create or replace function {{schema}}.count_tree
( _tree_access jsonb
, _query ltxtquery
, _access int4
)
returns bigint
as $func$
  with x as materialized
  (
    select a.tree_path
    from {{schema}}.tree_access(_tree_access) a
    where a.access >= _access
  )
  select count(*)
  from {{schema}}.memory m
  where m.tree @ _query
  and exists
  (
    select 1
    from x
    where x.tree_path @> m.tree
  )
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- list tree
-------------------------------------------------------------------------------
create or replace function {{schema}}.list_tree
( _tree_access jsonb
, _query lquery
)
returns table
( tree ltree
, count bigint
)
as $func$
  with a as materialized
  (
    select a.tree_path
    from {{schema}}.tree_access(_tree_access) a
    where a.access >= 1
  )
  , m as
  (
    select distinct m.id, m.tree
    from {{schema}}.memory m
    where m.tree ~ _query
    and exists
    (
      select 1
      from a
      where a.tree_path @> m.tree
    )
  )
  select
    subltree(m.tree, 0, i) as tree
  , count(m.id) as count
  from m
  cross join lateral generate_series(1, nlevel(m.tree)) i
  group by 1
  order by 1
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
