
-------------------------------------------------------------------------------
-- compute memory version hash
-------------------------------------------------------------------------------
create or replace function {{schema}}.compute_memory_version_hash
( _memory {{schema}}.memory
)
returns text
as $func$
  select pg_catalog.md5
  (
    pg_catalog.jsonb_build_object
    ( 'tree', _memory.tree::text
    , 'name', _memory.name
    , 'meta', _memory.meta
    , 'temporal', _memory.temporal::text
    , 'content', _memory.content
    )::text
  )
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
set timezone to 'UTC' -- ensure tstzrange renders to text deterministically
set datestyle to 'ISO, YMD' -- ensure tstzrange renders to text deterministically
;

-------------------------------------------------------------------------------
-- memory before update trigger
-------------------------------------------------------------------------------
create or replace function {{schema}}.memory_before_update()
returns trigger
as $func$
begin
  -- always update the timestamp
  new.updated_at = pg_catalog.now();

  -- if the content changed and we didn't also update the embedding
  -- increment the content version to signal that a new embedding needs to be generated
  if old.content is distinct from new.content
     and old.embedding is not distinct from new.embedding
  then
    new.embedding = null;
    new.content_version = old.content_version operator(pg_catalog.+) 1;
  end if;

  -- if the tree, temporal, name, meta, or content changed
  -- increment the version number
  -- and compute the new version hash
  if old.tree is distinct from new.tree
    or old.temporal is distinct from new.temporal
    or old.name is distinct from new.name
    or old.meta is distinct from new.meta
    or old.content is distinct from new.content
  then
    new.version = old.version operator(pg_catalog.+) 1;
    new.version_hash = {{schema}}.compute_memory_version_hash(new);
  else
    -- don't let someone explicitly change these
    new.version = old.version;
    new.version_hash = old.version_hash;
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
-- memory before insert trigger
-------------------------------------------------------------------------------
create or replace function {{schema}}.memory_before_insert()
returns trigger
as $func$
begin
  new.version = 1;
  new.version_hash = {{schema}}.compute_memory_version_hash(new);
  return new;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

create or replace trigger memory_before_insert_trg
before insert on {{schema}}.memory
for each row
execute function {{schema}}.memory_before_insert();

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
-- get_memory's result has changed over time (it gained columns), which
-- create-or-replace cannot do (42P13). The fn block drops a stale-signatured
-- definition before the create and asserts the result after — see
-- migrate/function_signature.sql.
{{fn get_memory(_tree_access jsonb, _id uuid) returns table(id uuid, tree ltree, meta jsonb, temporal tstzrange, content text, name text, version bigint, version_hash text, created_at timestamptz, updated_at timestamptz, has_embedding bool)}}
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
, version bigint
, version_hash text
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
  , m.version
  , m.version_hash
  , m.created_at
  , m.updated_at
  , m.embedding is not null
  from {{schema}}.memory m
  where m.id = _id
  and {{schema}}.has_tree_access(_tree_access, m.tree, 1)
$func$ language sql stable strict rows 1 security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

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
-- key (the explicit id, or the (tree, name) slot) under the default
-- _on_conflict ('error') is a hard error rather than a silent skip (the
-- 'replace'/'ignore' arms short-circuit before reaching here). Returns boolean
-- only so it can sit in a WHERE expression;
-- it never actually returns.
-------------------------------------------------------------------------------
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
-- raise_no_write_access
--
-- Raises insufficient_privilege (→ FORBIDDEN at the RPC boundary). Sits in the
-- create path's ON CONFLICT ... WHERE for the case where an explicit-id row
-- collides with an EXISTING row in a tree the caller can't write: under
-- 'replace' that replace can't be performed, so it's a hard error rather than a
-- silent no-op. Returns boolean only so it can sit in a WHERE expression; it
-- never actually returns.
-------------------------------------------------------------------------------
create or replace function {{schema}}.raise_no_write_access()
returns boolean
as $func$
begin
  raise exception 'insufficient tree access'
    using errcode = 'insufficient_privilege';
end;
$func$ language plpgsql volatile
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- batch create memory
--
-- The canonical memory insert: one set-based call for a whole batch
-- (create_memory below is a one-row wrapper). Parallel arrays, aligned by
-- position, carry the rows; _names is optional. The idempotency key — name
-- takes precedence over id:
--   - NAMED (name present, with OR without an explicit id) → dedup on
--     (tree, name). A supplied id is used only as the row's identity on INSERT
--     (importers mint a timestamp-prefixed v7 for chronological sort); on a
--     (tree, name) conflict the existing row — and its id — is kept.
--   - UNNAMED with an explicit id → dedup on the id (import/export identity).
--   - UNNAMED, no id → anonymous; always inserts.
-- On a conflict against that key the action is _on_conflict:
--   - 'replace' → replace in place, but only when content/meta/temporal differ
--                 (a no-op when identical, so a re-import is idempotent; an
--                 importer-version bump re-renders because the version lives in
--                 meta, so meta differs — this subsumes the old
--                 replaceIfMetaDiffers override)
--   - 'ignore'  → skip, leaving the existing row (insert-if-absent)
--   - 'error'   (default) → RAISE unique_violation (→ CONFLICT)
-- (An id-keyed replace also requires write access on the EXISTING row's tree,
-- since an id can move the row across trees; a (tree, name) replace stays in
-- the same tree, covered by the up-front check.) The (tree, name) unique index
-- is enforced on every path. `_on_conflict` governs the row's OWN idempotency
-- key; a NAMED row whose explicit id happens to collide with a DIFFERENT row's
-- id still raises a pk unique_violation regardless of 'ignore'/'replace' (the
-- id is taken) — importers mint random-tailed ids, so this never bites them.
--
-- Returns ONE row per input, in input order: (ord, id, status) where status is
-- 'inserted' | 'updated' | 'skipped' and id is the row's stored id (for a
-- skip/update on a (tree, name) key that is the EXISTING row's id, which may
-- differ from a submitted id). So a caller can map every result back to its
-- input by ord and see exactly what happened. Embedding columns are never set
-- here; the update trigger re-embeds only on content change, so a meta-only
-- replace does not re-embed.
--
-- A duplicate idempotency key WITHIN one batch is rejected up front
-- (invalid_parameter_value): a repeated explicit id, or a repeated (tree, name).
-- The caller can't express two outcomes for one key, and splitting the work
-- into per-key partitions would otherwise miss an id shared across a named and
-- an unnamed row. Target-tree write access is all-or-nothing up front.
--
-- The return type changed from (id, inserted) to (ord, id, status), which
-- create-or-replace cannot make (42P13); past argument changes also left stale
-- overloads (pre-name 7-arg, _replace_if_meta_differs 9-arg). The fn block drops
-- any same-named function whose signature differs before the create — sweeping
-- both the old result and the stale overloads — and asserts the result after.
-------------------------------------------------------------------------------
{{fn batch_create_memory(_tree_access jsonb, _ids uuid[], _trees ltree[], _contents text[], _metas jsonb, _temporals tstzrange[], _names text[], _on_conflict text) returns table(ord bigint, id uuid, status text)}}
create or replace function {{schema}}.batch_create_memory
( _tree_access jsonb
, _ids uuid[]                 -- null elements get a generated uuidv7
, _trees ltree[]
, _contents text[]
, _metas jsonb                -- json ARRAY of meta objects; null elements default to '{}'
, _temporals tstzrange[]
, _names text[] default null                  -- per-row leaf name; null = unnamed
, _on_conflict text default 'error'           -- 'error' | 'replace' | 'ignore'
)
returns table (ord bigint, id uuid, status text)  -- status: inserted | updated | skipped
as $func$
-- The out columns (id, ...) shadow table columns inside the body; the body
-- never reads them as variables, so resolve ambiguity to the columns.
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

  -- A duplicate idempotency key within the batch is ambiguous (two outcomes for
  -- one key) and would otherwise slip past the per-key partitions below.
  if exists
  (
    select 1 from unnest(_ids) u(id)
    where u.id is not null
    group by u.id having count(*) > 1
  ) then
    raise exception 'duplicate explicit id within batch'
      using errcode = 'invalid_parameter_value';
  end if;
  if _names is not null and exists
  (
    select 1 from unnest(_trees, _names) u(tree, name)
    where u.name is not null
    group by u.tree, u.name having count(*) > 1
  ) then
    raise exception 'duplicate (tree, name) within batch'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Check access to write targets before probing existing rows, so callers
  -- can't learn whether ids or (tree, name) slots exist outside their grant.
  if exists
  (
    select 1
    from unnest(_trees) t(tree)
    where not {{schema}}.has_tree_access(_tree_access, t.tree, 2)
  ) then
    raise exception 'insufficient tree access'
      using errcode = 'insufficient_privilege';
  end if;

  -- The keys above are distinct, but two inputs with DIFFERENT keys can still
  -- resolve to the same EXISTING row: an unnamed {id: X} and a {tree, name}
  -- whose slot already holds id X. Status is attributed by stored id, so that
  -- would mark both inputs from one write — breaking one-status-per-input (and
  -- two CTEs would touch the same row). Reject it. The id arm is restricted to
  -- UNNAMED explicit-id inputs (the id-keyed partition); a named row's explicit
  -- id is not a key (name wins), so a single named input whose id equals its own
  -- stored id is not a false positive.
  --
  -- The collision needs BOTH an explicit-id input and a named input, so skip
  -- this two-join probe against `memory` entirely when either is absent (e.g. a
  -- name-only or all-anonymous batch).
  if _names is not null
     and cardinality(array_remove(_ids, null)) > 0
     and exists
  (
    select 1 from
    (
      select m.id
      from unnest(_ids, _names) u(id, name)
      join {{schema}}.memory m on m.id = u.id
      where u.id is not null and u.name is null
      union all
      select m.id
      from unnest(_trees, _names) u(tree, name)
      join {{schema}}.memory m on m.tree = u.tree and m.name = u.name
      where u.name is not null
    ) x
    group by x.id having count(*) > 1
  ) then
    raise exception 'batch inputs target the same existing memory via different keys (explicit id and (tree, name))'
      using errcode = 'invalid_parameter_value';
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
  -- Unnamed + explicit id → keyed on the id. (Within-batch id dups already
  -- raised, so no dedup is needed here.)
  , with_id as
  (
    select r.* from r where r.explicit_id is not null and r.name is null
  )
  -- Named (with OR without an id) → keyed on (tree, name); a name takes
  -- precedence over the id as the dedup key. (Within-batch (tree, name) dups
  -- already raised.)
  , named as
  (
    select r.* from r where r.name is not null
  )
  -- No id, no name → anonymous; nothing to dedup.
  , anon as
  (
    select r.* from r where r.explicit_id is null and r.name is null
  )
  -- Unnamed explicit-id rows dedup on the id, so the row keeps it (import/export
  -- identity). An explicit id can collide with an existing row in a tree the
  -- caller can't write (the up-front check only covers the INPUT trees), so the
  -- conflict modes diverge there: 'error' always raises CONFLICT (so it never
  -- silently skips → INTERNAL_ERROR on read-back); 'ignore' skips; 'replace'
  -- raises (it can't perform the replace on an unwritable tree).
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
      when _on_conflict = 'error' then {{schema}}.raise_conflict()
      when _on_conflict = 'ignore' then false
      -- only 'replace' remains
      when not {{schema}}.has_tree_access(_tree_access, m.tree, 2)
        then {{schema}}.raise_no_write_access()
      -- an id-keyed replace can move/rename, so compare every updated field
      else m.tree is distinct from excluded.tree
           or m.name is distinct from excluded.name
           or m.content is distinct from excluded.content
           or m.meta is distinct from excluded.meta
           or m.temporal is distinct from excluded.temporal
    end
    returning m.id as id, (m.xmax = 0) as inserted
  )
  -- Named rows (with OR without an explicit id) dedup on (tree, name). On a
  -- fresh insert the row uses its explicit id when given (e.g. an importer's
  -- timestamp-prefixed v7), else a generated one; on a (tree, name) conflict the
  -- existing row's id is kept. A stray pk collision on a given id raises.
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
  -- Rows actually written this statement: (id, inserted=fresh-insert vs replace).
  , acted as
  (
    select id, inserted from ins_id
    union all
    select id, inserted from ins_named
    union all
    select id, inserted from ins_anon
  )
  -- The stored id per input. For a named row it is resolved by (tree, name):
  -- this subquery reads the PRE-statement snapshot (data-modifying CTEs aren't
  -- visible here), so an EXISTING row (update/skip) yields its kept id, while a
  -- fresh insert yields null → fall back to the row's own (minted) id. Unnamed
  -- and anonymous rows always keep their own id.
  , resolved as
  (
    select
      r.ord
    , case
        when r.name is not null then coalesce
        ( ( select mm.id
            from {{schema}}.memory mm
            where mm.tree = r.tree and mm.name = r.name )
        , r.id
        )
        else r.id
      end as id
    from r
  )
  -- One row per input, in order: present in `acted` → inserted/updated; absent
  -- → skipped (onConflict ignore, or a replace no-op).
  select
    res.ord
  , res.id
  , case
      when a.id is null then 'skipped'
      when a.inserted then 'inserted'
      else 'updated'
    end as status
  from resolved res
  left join acted a on a.id = res.id
  order by res.ord
  ;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

-------------------------------------------------------------------------------
-- create memory
--
-- One-row wrapper over batch_create_memory — see there for the conflict
-- semantics (insert / content-aware replace / skip). Returns exactly one row,
-- (id, status), mirroring the batch shape: id is the row's stored id (the kept
-- existing id on a (tree, name) update/skip — so callers can read it back even
-- on a skip), status is 'inserted' | 'updated' | 'skipped'.
--
-- The return type changed from (id, inserted) to (id, status), which
-- create-or-replace cannot make (42P13); past argument changes also left stale
-- overloads (pre-upsert 6-arg, pre-name 7-arg, _replace_if_meta_differs 9-arg).
-- The fn block drops any same-named function whose signature differs before the
-- create — sweeping both the old result and the stale overloads — and asserts
-- the result after.
-------------------------------------------------------------------------------
{{fn create_memory(_tree_access jsonb, _tree ltree, _content text, _id uuid, _meta jsonb, _temporal tstzrange, _name text, _on_conflict text) returns table(id uuid, status text)}}
create or replace function {{schema}}.create_memory
( _tree_access jsonb
, _tree ltree
, _content text
, _id uuid default null
, _meta jsonb default '{}'
, _temporal tstzrange default null
, _name text default null
, _on_conflict text default 'error'
)
returns table (id uuid, status text)
as $func$
  select b.id, b.status
  from {{schema}}.batch_create_memory(
    _tree_access,
    array[_id]::uuid[],
    array[_tree],
    array[_content],
    jsonb_build_array(coalesce(_meta, '{}'::jsonb)),
    array[_temporal],
    array[_name]::text[],
    _on_conflict
  ) b;
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

-------------------------------------------------------------------------------
-- patch memory
-------------------------------------------------------------------------------
{{fn patch_memory(_tree_access jsonb, _id uuid, _prior_version_hash text, _patch jsonb) returns bool}}
create or replace function {{schema}}.patch_memory
( _tree_access jsonb
, _id uuid
, _prior_version_hash text
, _patch jsonb
)
returns bool
as $func$
declare
  _version_hash text;
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

  -- find the existing memory and get it's tree and _version_hash
  select m.tree, m.version_hash into _src, _version_hash
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

  -- check tree access before version check. don't leak info

  -- make sure the memory hasn't changed since the patcher last read it
  if _version_hash is distinct from _prior_version_hash then
    raise exception 'stale version hash'
      using errcode = 'ME002';
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
{{endfn}}

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
    , name                  -- preserved; a (dst, name) clash raises 23505 → CONFLICT
    , tree
    , temporal
    , content
    , embedding
    , content_version
    )
    select
      m.meta
    , m.name
    , case
        when nlevel(m.tree) = nlevel(_src) then _dst
        else _dst || subpath(m.tree, nlevel(_src), nlevel(m.tree) - nlevel(_src))
      end as dst
    , m.temporal
    , m.content
    , m.embedding
    , m.content_version
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
-- reconcile tree
-------------------------------------------------------------------------------
-- Set-based reconcile-delete for importer-maintained subtrees: delete every
-- NAMED row under `_root` matching `_meta_contains` whose (tree, name) slot is
-- not in the keep-list — one statement, one snapshot, so there is no
-- enumerate/delete race and no page cap. The keep-list is the caller's walked
-- slot set (parallel arrays, per batch_create_memory); `_meta_contains` is the
-- ownership guard: only rows stamped by the calling importer (e.g.
-- {"source": "docs"}) are candidates, so foreign rows under the same root are
-- never touched. Unnamed rows are never candidates (no slot identity).
--
--   - Write access on `_root` is required up front, all-or-nothing (the
--     batch_create rule) — no silent partial reconcile against whichever
--     sub-branches the caller happens to own.
--   - `_meta_contains` must be a non-empty object: an unscoped reconcile
--     ("delete everything not in my list") is refused here, not left to
--     caller policy.
--   - `_dry_run` returns the would-delete rows from the same predicate
--     without deleting, so a preview is exact at any corpus size.
--
-- Returns the affected (deleted, or would-delete) rows.
{{fn reconcile_tree(_tree_access jsonb, _root ltree, _meta_contains jsonb, _keep_trees ltree[], _keep_names text[], _dry_run boolean) returns table(id uuid, tree ltree, name text)}}
create or replace function {{schema}}.reconcile_tree
( _tree_access jsonb
, _root ltree                 -- subtree to reconcile under (e.g. a docs root)
, _meta_contains jsonb        -- ownership scope, e.g. '{"source": "docs"}'
, _keep_trees ltree[]         -- keep-list slots: trees ...
, _keep_names text[]          -- ... and names, aligned by position
, _dry_run boolean default false
)
returns table (id uuid, tree ltree, name text)
as $func$
-- The out columns shadow table columns inside the body; the body never reads
-- them as variables, so resolve ambiguity to the columns.
#variable_conflict use_column
begin
  if jsonb_typeof(_meta_contains) is distinct from 'object'
     or _meta_contains = '{}'::jsonb
  then
    raise exception 'reconcile_tree requires a non-empty _meta_contains scope'
      using errcode = 'invalid_parameter_value';
  end if;

  if cardinality(_keep_trees) is distinct from cardinality(_keep_names) then
    raise exception 'keep-list arrays must have equal lengths'
      using errcode = 'invalid_parameter_value';
  end if;

  -- A null slot component can never match a row (null = x is null), which
  -- would silently turn "keep" into "delete" — reject it instead.
  if exists (select 1 from unnest(_keep_trees) t(x) where t.x is null)
     or exists (select 1 from unnest(_keep_names) n(x) where n.x is null)
  then
    raise exception 'keep-list entries must be non-null'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Write authority over the whole root, up front (all-or-nothing).
  -- `is not true` so a null verdict can never slip past the gate.
  if {{schema}}.has_tree_access(_tree_access, _root, 2) is not true then
    raise exception 'insufficient tree access'
      using errcode = 'insufficient_privilege';
  end if;

  if _dry_run then
    return query
      select m.id, m.tree, m.name
      from {{schema}}.memory m
      where m.tree <@ _root
      and m.name is not null
      and m.meta @> _meta_contains
      and not exists
      (
        select 1
        from unnest(_keep_trees, _keep_names) k(tree, name)
        where k.tree = m.tree and k.name = m.name
      );
  else
    return query
      delete from {{schema}}.memory m
      where m.tree <@ _root
      and m.name is not null
      and m.meta @> _meta_contains
      and not exists
      (
        select 1
        from unnest(_keep_trees, _keep_names) k(tree, name)
        where k.tree = m.tree and k.name = m.name
      )
      returning m.id, m.tree, m.name;
  end if;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

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
