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
, _id uuid default null
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
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- create memory
--
-- Returns the new memory's id, or null when an explicit _id already exists
-- (on conflict do nothing). The null lets importers with deterministic ids
-- re-submit safely — the caller classifies a missing id as "skipped".
-------------------------------------------------------------------------------
create or replace function {{schema}}.create_memory
( _tree_access jsonb
, _tree ltree
, _content text
, _id uuid default null
, _meta jsonb default '{}'
, _temporal tstzrange default null
)
returns uuid
as $func$
begin
  if not {{schema}}.has_tree_access(_tree_access, _tree, 2) then
    raise exception 'insufficient tree access'
      using errcode = 'insufficient_privilege';
  end if;

  insert into {{schema}}.memory
  ( id
  , tree
  , meta
  , temporal
  , content
  )
  values
  ( coalesce(_id, uuidv7())
  , _tree
  , coalesce(_meta, '{}'::jsonb)
  , _temporal
  , _content
  )
  on conflict (id) do nothing
  returning id into _id
  ;
  return _id;
end;
$func$ language plpgsql volatile security invoker
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
