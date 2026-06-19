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
-- get_memory gained a `name` return column (a return-type change, which
-- create-or-replace cannot make → 42P13 "cannot change return type"). Drop a
-- prior definition only when it lacks `name` among its columns — this also
-- covers the historical `_id default null` variant — a no-op on fresh schemas
-- and once current. The create-or-replace below then recreates it.
do $$ begin
  if exists
  (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = '{{schema}}'
    and p.proname = 'get_memory'
    and not ('name' = any(coalesce(p.proargnames, array[]::text[])))
  ) then
    drop function {{schema}}.get_memory(jsonb, uuid);
  end if;
end $$;
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
, name text
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
  , m.name
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
-- resolve memory id
--
-- Translate a `(tree, name)` reference to the memory's id, gated on read access
-- (level 1) so a non-reader can't probe existence. Returns null when there is
-- no such named memory or the caller can't read it. The RPC layer resolves a
-- `folder/name` address to an id with this, then calls get/patch/delete by id.
-------------------------------------------------------------------------------
create or replace function {{schema}}.resolve_memory_id
( _tree_access jsonb
, _tree ltree
, _name text
)
returns uuid
as $func$
  select m.id
  from {{schema}}.memory m
  where m.tree = _tree
  and m.name = _name
  and {{schema}}.has_tree_access(_tree_access, m.tree, 1)
$func$ language sql stable strict security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- raise_conflict
--
-- Raises a unique_violation (23505 → CONFLICT at the RPC boundary). Called from
-- the create path's ON CONFLICT ... WHERE so that a conflict on the idempotency
-- key (the explicit id, or the (tree, name) slot) with no conflict-handling
-- directive (no _upsert, no _replace_if_meta_differs) is a hard error rather
-- than a silent skip. Returns boolean only so it can sit in a WHERE expression;
-- it never actually returns.
-------------------------------------------------------------------------------
drop function if exists {{schema}}.raise_conflict(ltree, text);
create or replace function {{schema}}.raise_conflict()
returns boolean
as $func$
begin
  raise exception 'memory already exists (id or tree/name conflict)'
    using errcode = 'unique_violation';
end;
$func$ language plpgsql volatile
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- batch create memory
--
-- The canonical memory insert: one set-based call for a whole batch
-- (create_memory below is a one-row wrapper). Parallel arrays, aligned by
-- position, carry the rows; _names is optional. The idempotency key is the
-- explicit id WHEN PROVIDED, otherwise the (tree, name) slot:
--   - EXPLICIT id (with or without a name) → dedup on the id, so import/export
--     and deterministic importers preserve identity. The row keeps its id; a
--     set name that collides with a DIFFERENT row still trips the (tree, name)
--     unique index and raises.
--   - NO id but NAMED → dedup on (tree, name).
--   - NO id, NO name → anonymous; always inserts.
-- On a conflict against that key the action is _on_conflict:
--   - 'replace' → replace in place, but only when content/meta/temporal differ
--                 (a no-op when identical, so a re-import is idempotent and an
--                 importer-version bump — version lives in meta — re-renders)
--   - 'ignore'  → skip, leaving the existing row (insert-if-absent)
--   - 'error'   (default) → RAISE unique_violation (→ CONFLICT)
-- _replace_if_meta_differs is a transitional override: when set, replace iff
-- that meta key differs, else skip. (An id-keyed replace also requires write
-- access on the EXISTING row's tree, else the row is skipped so one
-- inaccessible row can't fail the batch.) The (tree, name) unique index is
-- enforced on every path, so names stay unique regardless of the dedup key.
--
-- Returns one row (id, inserted) per insert/replace — inserted distinguishes a
-- fresh insert (true, xmax = 0) from a replace (false); skipped rows are absent.
-- Target-tree write access is all-or-nothing up front. Within the batch, a
-- repeated id — or (tree, name) — collapses to its first occurrence (a single
-- INSERT cannot touch the same row twice). Embedding columns are never set
-- here; the update trigger re-embeds only on content change, so a meta-only
-- replace does not re-embed.
--
-- The drop covers the pre-name 7-arg signature: the trailing _names /
-- _on_conflict params (both defaulted) otherwise leave an overload that makes a
-- 6/7-arg call ambiguous. No-op on fresh schemas.
-------------------------------------------------------------------------------
drop function if exists {{schema}}.batch_create_memory(jsonb, uuid[], ltree[], text[], jsonb, tstzrange[], text);
create or replace function {{schema}}.batch_create_memory
( _tree_access jsonb
, _ids uuid[]                 -- null elements get a generated uuidv7
, _trees ltree[]
, _contents text[]
, _metas jsonb                -- json ARRAY of meta objects; null elements default to '{}'
, _temporals tstzrange[]
, _replace_if_meta_differs text default null  -- transitional; overrides _on_conflict when set
, _names text[] default null                  -- per-row leaf name; null = unnamed
, _on_conflict text default 'error'           -- 'error' | 'replace' | 'ignore'
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
     or (_names is not null and cardinality(_ids) is distinct from cardinality(_names))
  then
    raise exception 'batch arrays must have equal lengths'
      using errcode = 'invalid_parameter_value';
  end if;

  if _on_conflict is null or _on_conflict not in ('error', 'replace', 'ignore') then
    raise exception 'invalid _on_conflict: %', _on_conflict
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
      u.id as explicit_id                  -- null = no client-supplied id
    , coalesce(u.id, uuidv7()) as id        -- the row's identity (generated if absent)
    , u.tree
    , coalesce(nullif(e.meta, 'null'::jsonb), '{}'::jsonb) as meta
    , u.temporal
    , u.content
    , u.name
    , u.ord
    from unnest
         ( _ids
         , _trees
         , _contents
         , _temporals
         , coalesce(_names, array_fill(null::text, array[cardinality(_ids)]))
         )
         with ordinality u(id, tree, content, temporal, name, ord)
    join jsonb_array_elements(_metas) with ordinality e(meta, ord)
      on e.ord = u.ord
  )
  -- Explicit id → keyed on the id; first occurrence within the batch wins.
  , with_id as
  (
    select distinct on (r.explicit_id) r.*
    from r where r.explicit_id is not null
    order by r.explicit_id, r.ord
  )
  -- No id but named → keyed on (tree, name); first occurrence wins.
  , named as
  (
    select distinct on (r.tree, r.name) r.*
    from r where r.explicit_id is null and r.name is not null
    order by r.tree, r.name, r.ord
  )
  -- No id, no name → anonymous; nothing to dedup.
  , anon as
  (
    select r.* from r where r.explicit_id is null and r.name is null
  )
  -- Explicit-id rows dedup on the id, so the row keeps it (import/export
  -- identity). A set name that collides with a DIFFERENT row still trips the
  -- (tree, name) unique index → raises. A replace needs write access on the
  -- existing row's tree (else skipped, so one inaccessible row can't fail it).
  , ins_id as
  (
    insert into {{schema}}.memory as m
    ( id, tree, meta, temporal, content, name )
    select w.id, w.tree, w.meta, w.temporal, w.content, w.name
    from with_id w
    on conflict (id) do update set
      tree = excluded.tree
    , meta = excluded.meta
    , temporal = excluded.temporal
    , content = excluded.content
    , name = excluded.name
    where case
      when not {{schema}}.has_tree_access(_tree_access, m.tree, 2) then false
      when _replace_if_meta_differs is not null
        then m.meta->>_replace_if_meta_differs
             is distinct from excluded.meta->>_replace_if_meta_differs
      when _on_conflict = 'replace'
        -- an id-keyed replace can move/rename, so compare every updated field
        then m.tree is distinct from excluded.tree
             or m.name is distinct from excluded.name
             or m.content is distinct from excluded.content
             or m.meta is distinct from excluded.meta
             or m.temporal is distinct from excluded.temporal
      when _on_conflict = 'ignore' then false
      else {{schema}}.raise_conflict()
    end
    returning m.id as id, (m.xmax = 0) as inserted
  )
  -- Named (no id) rows dedup on (tree, name); the row keeps its generated id.
  , ins_named as
  (
    insert into {{schema}}.memory as m
    ( id, tree, meta, temporal, content, name )
    select n.id, n.tree, n.meta, n.temporal, n.content, n.name
    from named n
    on conflict (tree, name) where name is not null do update set
      meta = excluded.meta
    , temporal = excluded.temporal
    , content = excluded.content
    where case
      when _replace_if_meta_differs is not null
        then m.meta->>_replace_if_meta_differs
             is distinct from excluded.meta->>_replace_if_meta_differs
      when _on_conflict = 'replace'
        then m.content is distinct from excluded.content
             or m.meta is distinct from excluded.meta
             or m.temporal is distinct from excluded.temporal
      when _on_conflict = 'ignore' then false
      else {{schema}}.raise_conflict()
    end
    returning m.id as id, (m.xmax = 0) as inserted
  )
  -- Anonymous rows always insert (their generated id is unique).
  , ins_anon as
  (
    insert into {{schema}}.memory as m
    ( id, tree, meta, temporal, content, name )
    select a.id, a.tree, a.meta, a.temporal, a.content, a.name
    from anon a
    returning m.id as id, true as inserted
  )
  select id, inserted from ins_id
  union all
  select id, inserted from ins_named
  union all
  select id, inserted from ins_anon
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
-- The drops cover the pre-upsert 6-arg and pre-name 7-arg signatures — without
-- them, create would add an ambiguous overload. No-op on re-runs.
-------------------------------------------------------------------------------
drop function if exists {{schema}}.create_memory(jsonb, ltree, text, uuid, jsonb, tstzrange);
drop function if exists {{schema}}.create_memory(jsonb, ltree, text, uuid, jsonb, tstzrange, text);
create or replace function {{schema}}.create_memory
( _tree_access jsonb
, _tree ltree
, _content text
, _id uuid default null
, _meta jsonb default '{}'
, _temporal tstzrange default null
, _replace_if_meta_differs text default null
, _name text default null
, _on_conflict text default 'error'
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
    _replace_if_meta_differs,
    array[_name]::text[],
    _on_conflict
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
  select count(*) filter (where k in ('meta', 'tree', 'temporal', 'content', 'name')) > 0
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

  -- A rename or a move into a tree that already has this name violates the
  -- (tree, name) unique index; that 23505 propagates and is mapped to CONFLICT
  -- at the RPC boundary. Setting name to JSON null clears it.
  update {{schema}}.memory m set
    tree = case when _patch ? 'tree' then (_patch->>'tree')::ltree else m.tree end
  , meta = case when _patch ? 'meta' then _patch->'meta' else m.meta end
  , temporal = case when _patch ? 'temporal' then (_patch->>'temporal')::tstzrange else m.temporal end
  , content = case when _patch ? 'content' then _patch->>'content' else m.content end
  , name = case when _patch ? 'name' then (_patch->>'name') else m.name end
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
, _max_count int8 default null
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
  from
  (
    select 1
    from {{schema}}.memory m
    where _tree @> m.tree
    and exists
    (
      select 1
      from x
      where x.tree_path @> m.tree
    )
    limit _max_count
  ) x
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
, _max_count int8 default null
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
  from
  (
    select 1
    from {{schema}}.memory m
    where m.tree ~ _query
    and exists
    (
      select 1
      from x
      where x.tree_path @> m.tree
    )
    limit _max_count
  ) x
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
, _max_count int8 default null
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
  from
  (
    select 1
    from {{schema}}.memory m
    where m.tree @ _query
    and exists
    (
      select 1
      from x
      where x.tree_path @> m.tree
    )
    limit _max_count
  ) x
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
