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
  if not {{schema}}.has_tree_privilege(_user_id, _tree, array['update']) then
    raise exception 'user (%) must be a superuser or own or have update on the tree path %', _user_id, _tree
      using errcode = 'insufficient_privilege';
  end if;

  update {{schema}}.memory set
    tree = _tree
  , meta = meta || _meta
  , temporal = _temporal
  , content = _content
  where id = _id
  ;
  return found;
end;
$func$ language plpgsql volatile security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- move memories
-------------------------------------------------------------------------------
create or replace function {{schema}}.move_memories
( _user_id uuid
, _query lquery
, _to ltree
)
returns uuid[]
as $func$
declare
  _moved uuid[];
begin
  -- must have create on target tree path
  if not {{schema}}.has_tree_privilege(_user_id, _to, array['create']) then
    raise exception 'user (%) must be a superuser or own or have create on the tree path %', _user_id, _to
      using errcode = 'insufficient_privilege';
  end if;

  with x as
  (
    -- must have update on source tree paths
    select
      p.role_id
    , p.tree_path
    from {{schema}}.calc_tree_privileges(_user_id) p
    where p.actions @> array['update']
  )
  , u as
  (
    update {{schema}}.memory m set tree = _to
    from x
    where m.tree ~ _query
    and x.tree_path @> m.tree
    returning id
  )
  select array_agg(u.id) into strict _moved
  from u
  ;

  return _moved;
end;
$func$ language plpgsql volatile security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- move memories
-------------------------------------------------------------------------------
create or replace function {{schema}}.move_memories
( _user_id uuid
, _query ltxtquery
, _to ltree
)
returns uuid[]
as $func$
declare
  _moved uuid[];
begin
  -- must have create on target tree path
  if not {{schema}}.has_tree_privilege(_user_id, _to, array['create']) then
    raise exception 'user (%) must be a superuser or own or have create on the tree path %', _user_id, _to
      using errcode = 'insufficient_privilege';
  end if;

  with x as
  (
    -- must have update on source tree paths
    select
      p.role_id
    , p.tree_path
    from {{schema}}.calc_tree_privileges(_user_id) p
    where p.actions @> array['update']
  )
  , u as
  (
    update {{schema}}.memory m set tree = _to
    from x
    where m.tree @ _query
    and x.tree_path @> m.tree
    returning id
  )
  select array_agg(u.id) into strict _moved
  from u
  ;

  return _moved;
end;
$func$ language plpgsql volatile security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- copy memories
-------------------------------------------------------------------------------
create or replace function {{schema}}.copy_memories
( _user_id uuid
, _query lquery
, _to ltree
)
returns uuid[]
as $func$
declare
  _copied uuid[];
begin
  -- must have create on target tree path
  if not {{schema}}.has_tree_privilege(_user_id, _to, array['create']) then
    raise exception 'user (%) must be a superuser or own or have create on the tree path %', _user_id, _to
      using errcode = 'insufficient_privilege';
  end if;

  with x as
  (
    -- must have read on source tree paths
    select
      p.role_id
    , p.tree_path
    from {{schema}}.calc_tree_privileges(_user_id) p
    where p.actions @> array['read']
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
    , _to
    , m.temporal
    , m.content
    , m.embedding
    , m.embedding_version
    from {{schema}}.memory m
    inner join x on (x.tree_path @> m.tree)
    where m.tree ~ _query
    returning id
  )
  select array_agg(i.id) into strict _copied
  from i
  ;

  return _copied;
end;
$func$ language plpgsql volatile security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- copy memories
-------------------------------------------------------------------------------
create or replace function {{schema}}.copy_memories
( _user_id uuid
, _query ltxtquery
, _to ltree
)
returns uuid[]
as $func$
declare
  _copied uuid[];
begin
  -- must have create on target tree path
  if not {{schema}}.has_tree_privilege(_user_id, _to, array['create']) then
    raise exception 'user (%) must be a superuser or own or have create on the tree path %', _user_id, _to
      using errcode = 'insufficient_privilege';
  end if;

  with x as
  (
    -- must have read on source tree paths
    select
      p.role_id
    , p.tree_path
    from {{schema}}.calc_tree_privileges(_user_id) p
    where p.actions @> array['read']
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
    , _to
    , m.temporal
    , m.content
    , m.embedding
    , m.embedding_version
    from {{schema}}.memory m
    inner join x on (x.tree_path @> m.tree)
    where m.tree @ _query
    returning id
  )
  select array_agg(i.id) into strict _copied
  from i
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
-- delete memories
-------------------------------------------------------------------------------
create or replace function {{schema}}.delete_memories
( _user_id uuid
, _query lquery
)
returns uuid[]
as $func$
  with x as
  (
    select
      p.role_id
    , p.tree_path
    from {{schema}}.calc_tree_privileges(_user_id) p
    where p.actions @> array['delete']
  )
  , d as
  (
    delete from {{schema}}.memory m
    using x
    where m.tree ~ _query
    and x.tree_path @> m.tree
    returning id
  )
  select array_agg(d.id)
  from d
$func$ language sql volatile security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- delete memories
-------------------------------------------------------------------------------
create or replace function {{schema}}.delete_memories
( _user_id uuid
, _query ltxtquery
)
returns uuid[]
as $func$
  with x as
  (
    select
      p.role_id
    , p.tree_path
    from {{schema}}.calc_tree_privileges(_user_id) p
    where p.actions @> array['delete']
  )
  , d as
  (
    delete from {{schema}}.memory m
    using x
    where m.tree @ _query
    and x.tree_path @> m.tree
    returning id
  )
  select array_agg(d.id)
  from d
$func$ language sql volatile security definer
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
