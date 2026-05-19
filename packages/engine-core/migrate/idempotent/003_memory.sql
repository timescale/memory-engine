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
$func$ language plpgsql volatile security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp -- public required for pgvector's `is not distinct from`
;

create or replace trigger memory_before_update_trg
before update on {{schema}}.memory
for each row
execute function {{schema}}.memory_before_update();

-------------------------------------------------------------------------------
-- get memory
-------------------------------------------------------------------------------
create or replace function {{schema}}.get_memory
( _user_id uuid
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
  into _memory
  from {{schema}}.memory m
  where m.id = _id
  and {{schema}}.has_tree_privilege(_user_id, m.tree, array['read'])
$func$ language sql stable security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- create memory
-------------------------------------------------------------------------------
create or replace function {{schema}}.create_memory
( _user_id uuid
, _tree ltree
, _content text
, _id uuid default null
, _meta jsonb default '{}'
, _temporal tstzrange default null
)
returns uuid
as $func$
begin
  if not {{schema}}.has_tree_privilege(_user_id, _tree, array['create']) then
    raise exception 'user (%) must be a superuser or own or have create on the tree path %', _user_id, _tree
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
  returning id into strict _id
  ;
  return _id;
end;
$func$ language plpgsql volatile security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- update memory
-------------------------------------------------------------------------------
create or replace function {{schema}}.update_memory
( _user_id uuid
, _id uuid
, _tree ltree
, _content text
, _meta jsonb default '{}'
, _temporal tstzrange default null
)
returns bool
as $func$
begin
  with p as materialized
  (
    select p.tree_path, p.actions
    from {{schema}}.calc_tree_privileges(_user_id) p
  )
  update {{schema}}.memory m set
    tree = _tree
  , meta = meta || _meta
  , temporal = _temporal
  , content = _content
  where m.id = _id
  and exists
  (
    select 1
    from p
    where p.tree_path @> m.tree
    and p.actions @> array['update']
  )
  and (m.tree @> _tree or exists
  (
    select 1
    from p
    where p.tree_path @> _tree
    and p.actions @> array['insert']
  ))
  ;
  return found;
end;
$func$ language plpgsql volatile security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- move tree
-------------------------------------------------------------------------------
create or replace function {{schema}}.move_tree
( _user_id uuid
, _src ltree
, _dst ltree
, _dry_run bool default false
)
returns bigint
as $func$
declare
  _moved bigint;
begin
  -- must have create on _dst tree path
  if not {{schema}}.has_tree_privilege(_user_id, _dst, array['create']) then
    raise exception 'user (%) must be a superuser or own or have create on the tree path %', _user_id, _dst
      using errcode = 'insufficient_privilege';
  end if;

  with p as materialized
  (
    select p.tree_path
    from {{schema}}.calc_tree_privileges(_user_id) p
  )
  , x as
  (
    select m.id
    from {{schema}}.memory m
    where _src @> m.tree
    and exists
    (
      select 1
      from p
      where p.tree_path @> m.tree
      and p.actions @> array['read']
    )
    and
    (
      m.tree @> _dst
      and exists
      (
        select 1
        from p.tree_path @> m.tree

      )
    )
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
$func$ language plpgsql volatile security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- copy tree
-------------------------------------------------------------------------------
create or replace function {{schema}}.copy_tree
( _user_id uuid
, _src ltree
, _dst ltree
, _dry_run bool default false
)
returns bigint
as $func$
declare
  _copied bigint;
begin
  -- must have create on _dst tree path
  if not {{schema}}.has_tree_privilege(_user_id, _dst, array['create']) then
    raise exception 'user (%) must be a superuser or own or have create on the tree path %', _user_id, _dst
      using errcode = 'insufficient_privilege';
  end if;

  with p as materialized
  (
    select p.tree_path
    from {{schema}}.calc_tree_privileges(_user_id) p
    where p.actions @> array['read']
  )
  , m as
  (
    select m.*
    from {{schema}}.memory m
    where _src @> m.tree
    and exists
    (
      select 1
      from p
      where p.tree_path @> m.tree
    )
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
$func$ language plpgsql volatile security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- delete memory
-------------------------------------------------------------------------------
create or replace function {{schema}}.delete_memory
( _user_id uuid
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
  ;

  if not found then
    return false;
  end if;

  if not {{schema}}.has_tree_privilege(_user_id, _tree, array['delete']) then
    raise exception 'user (%) must be a superuser or own or have delete on the tree path %', _user_id, _tree
      using errcode = 'insufficient_privilege';
  end if;

  delete from {{schema}}.memory
  where id = _id
  ;
  return found;
end;
$func$ language plpgsql volatile security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- delete tree
-------------------------------------------------------------------------------
create or replace function {{schema}}.delete_tree
( _user_id uuid
, _tree ltree
, _dry_run bool default false
)
returns bigint
as $func$
  with p as materialized
  (
    select p.tree_path
    from {{schema}}.calc_tree_privileges(_user_id) p
    where p.actions @> array['delete']
  )
  , m as
  (
    select m.id
    from {{schema}}.memory m
    where _tree @> m.tree
    and exists
    (
      select 1
      from p
      where p.tree @> m.tree
    )
  )
  , d as
  (
    delete from {{schema}}.memory m
    using x
    where m.id = x.id
    and not _dry_run
  )
  select count(*)
  from x
$func$ language sql volatile security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- count tree
-------------------------------------------------------------------------------
create or replace function {{schema}}.count_tree
( _user_id uuid
, _query lquery
, _actions text[]
)
returns bigint
as $func$
  with x as materialized
  (
    select p.tree_path
    from {{schema}}.calc_tree_privileges(_user_id) p
    where p.actions @> (coalesce(_actions, array['read']))
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
$func$ language sql stable security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- count tree
-------------------------------------------------------------------------------
create or replace function {{schema}}.count_tree
( _user_id uuid
, _query ltxtquery
, _actions text[]
)
returns bigint
as $func$
  with x as materialized
  (
    select p.tree_path
    from {{schema}}.calc_tree_privileges(_user_id) p
    where p.actions @> (coalesce(_actions, array['read']))
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
$func$ language sql stable security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- list tree
-------------------------------------------------------------------------------
create or replace function {{schema}}.list_tree
( _user_id uuid
, _query lquery
)
returns table
( tree ltree
, count bigint
)
as $func$
  with p as
  (
    select p.tree_path
    from {{schema}}.calc_tree_privileges(_user_id) p
    where p.actions @> array['read']
  )
  , m as
  (
    select distinct m.id, m.tree
    from {{schema}}.memory m
    where m.tree ~ _query
    and exists
    (
      select 1
      from p
      where p.tree_path @> m.tree
    )
  )
  select
    subltree(m.tree, 0, i) as tree
  , count(m.id) as count
  from m
  cross join lateral generate_series(1, nlevel(m.tree)) i
  group by 1
  order by 1
$func$ language sql stable security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
