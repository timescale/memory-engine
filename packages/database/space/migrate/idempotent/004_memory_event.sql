-------------------------------------------------------------------------------
-- memory_event_context
-------------------------------------------------------------------------------
create or replace function {{schema}}.memory_event_context()
returns jsonb
as $func$
declare
  _event_context jsonb;
begin
  _event_context = coalesce(nullif(current_setting('me.event_context', true), '')::jsonb, '{}'::jsonb);
  if not (_event_context ? 'operation_id') then
    _event_context = jsonb_set(_event_context, '{operation_id}', to_jsonb(uuidv7()));
    perform set_config('me.event_context', _event_context::text, true);
  end if;
  return _event_context;
end
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- memory_log_event
-------------------------------------------------------------------------------
create or replace function {{schema}}.memory_log_event()
returns trigger
as $func$
declare
  _event_context jsonb;
begin
  if tg_op = 'INSERT'
     or tg_op = 'DELETE'
     or row(old.tree, old.temporal, old.name, old.meta, old.content)
        is distinct from
        row(new.tree, new.temporal, new.name, new.meta, new.content)
  then
    _event_context = {{schema}}.memory_event_context();
    insert into {{schema}}.memory_event
    ( memory_id
    , operation
    , operation_id
    , cause
    , actor
    , tree
    , name
    , meta
    , temporal
    , content
    , content_version
    , version
    , version_hash
    )
    values
    ( case when tg_op = 'DELETE' then old.id else new.id end
    , lower(tg_op)
    , (_event_context->>'operation_id')::uuid
    , _event_context->>'cause'
    , _event_context - 'cause' - 'operation_id'
    , case when tg_op = 'DELETE' then old.tree else new.tree end
    , case when tg_op = 'DELETE' then old.name else new.name end
    , case when tg_op = 'DELETE' then old.meta else new.meta end
    , case when tg_op = 'DELETE' then old.temporal else new.temporal end
    , case when tg_op = 'DELETE' then old.content else new.content end
    , case when tg_op = 'DELETE' then old.content_version else new.content_version end
    , case when tg_op = 'DELETE' then old.version else new.version end
    , case when tg_op = 'DELETE' then old.version_hash else new.version_hash end
    );

  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

create or replace trigger memory_log_event_trg
after insert or update or delete on {{schema}}.memory
for each row execute function {{schema}}.memory_log_event();

-------------------------------------------------------------------------------
-- get_memory_history
--
-- Read the append-only audit log. Every returned row is gated on read access
-- (level 1) to that event's own tree, so a snapshot from a tree the caller
-- cannot read is never returned — history for a memory that moved between trees
-- may therefore look partial. Filters are all nullable; the caller supplies at
-- least one of _memory_id / _tree / _operation_id / _since (enforced at the RPC
-- layer). Deleted memories remain visible (their tombstone events outlive the row).
-------------------------------------------------------------------------------
{{fn get_memory_history(_tree_access jsonb, _memory_id uuid, _tree ltree, _operation text, _operation_id uuid, _since timestamptz, _until timestamptz, _cursor_event_id uuid, _limit bigint, _order text) returns table(event_id uuid, at timestamptz, memory_id uuid, operation text, operation_id uuid, cause text, actor jsonb, tree ltree, name text, meta jsonb, temporal tstzrange, content text, version bigint, version_hash text)}}
create or replace function {{schema}}.get_memory_history
( _tree_access jsonb
, _memory_id uuid
, _tree ltree
, _operation text
, _operation_id uuid
, _since timestamptz
, _until timestamptz
, _cursor_event_id uuid
, _limit bigint
, _order text
)
returns table
( event_id uuid
, at timestamptz
, memory_id uuid
, operation text
, operation_id uuid
, cause text
, actor jsonb
, tree ltree
, name text
, meta jsonb
, temporal tstzrange
, content text
, version bigint
, version_hash text
)
as $func$
begin
  -- guard the sort direction (it is not otherwise constrained here)
  if _order is null or _order not in ('asc', 'desc') then
    _order = 'desc';
  end if;

  _since = coalesce(_since, '-infinity'::timestamptz);
  _until = coalesce(_until, 'infinity'::timestamptz);

  return query
  select
    e.event_id
  , e.at
  , e.memory_id
  , e.operation
  , e.operation_id
  , e.cause
  , e.actor
  , e.tree
  , e.name
  , e.meta
  , e.temporal
  , e.content
  , e.version
  , e.version_hash
  from {{schema}}.memory_event e
  where {{schema}}.has_tree_access(_tree_access, e.tree, 1)
  and (_memory_id is null or e.memory_id = _memory_id)
  and (_tree is null or e.tree operator(public.<@) _tree)
  and (_operation is null or e.operation = _operation)
  and (_operation_id is null or e.operation_id = _operation_id)
  and e.at >= _since
  and e.at < _until
  -- keyset cursor on event_id (uuidv7): a unique, chronological total order, so
  -- ordering by it matches the seek predicate exactly — exact pagination with no
  -- (at, event_id) ordering mismatch or timestamp-precision loss. `at` still
  -- drives the since/until window (and hypertable chunk pruning) above; every
  -- query is bounded by a scope, so this orders a bounded candidate set.
  and (
    _cursor_event_id is null
    or (_order = 'desc' and e.event_id < _cursor_event_id)
    or (_order = 'asc' and e.event_id > _cursor_event_id)
  )
  order by
    case when _order = 'asc' then e.event_id end asc
  , case when _order = 'desc' then e.event_id end desc
  limit _limit;
end
$func$ language plpgsql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

-------------------------------------------------------------------------------
-- resolve_memory_id_from_history
--
-- Resolve a (tree, name) path to a memory id using the audit log, so a DELETED
-- memory's history is reachable by path (the live table no longer has the row).
-- Returns the most-recently-seen memory id at that path the caller can read, or
-- null. Callers try the live resolver first; the live id wins when a (tree,
-- name) slot was reused after a delete.
-------------------------------------------------------------------------------
create or replace function {{schema}}.resolve_memory_id_from_history
( _tree_access jsonb
, _tree ltree
, _name text
)
returns uuid
as $func$
  select e.memory_id
  from {{schema}}.memory_event e
  where e.tree = _tree
  and e.name = _name
  and {{schema}}.has_tree_access(_tree_access, e.tree, 1)
  order by e.at desc, e.event_id desc
  limit 1
$func$ language sql stable strict security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- revert_memory
--
-- Restore a memory's current state to the snapshot recorded for `_version` in
-- the audit log, applied as a normal forward mutation (a new version + a logged
-- 'revert' event, via the trigger). A live memory is updated in place; a DELETED
-- memory is re-inserted (undelete) with a version that continues its historical
-- sequence, so version numbers stay monotonic per id.
--
-- Access mirrors patch_memory: write (level 2) on the current tree and, when the
-- version lived elsewhere, on the snapshot tree too (undelete needs write on the
-- snapshot tree). The snapshot read is gated on read access, so a version in an
-- unreadable tree — or one dropped by retention — is NOT_FOUND (returns false).
-- `_expected_version_hash`, when non-null, guards a concurrent change on a live
-- memory (stale → ME002); null is a deliberate override. A rename/move into an
-- occupied (tree, name) slot raises 23505 → CONFLICT at the RPC boundary.
-------------------------------------------------------------------------------
{{fn revert_memory(_tree_access jsonb, _id uuid, _version bigint, _expected_version_hash text) returns bool}}
create or replace function {{schema}}.revert_memory
( _tree_access jsonb
, _id uuid
, _version bigint
, _expected_version_hash text
)
returns bool
as $func$
declare
  _content text;
  _meta jsonb;
  _tree ltree;
  _temporal tstzrange;
  _name text;
  _cur_tree ltree;
  _cur_hash text;
  _next_version bigint;
  _next_content_version int;
begin
  -- 1. the version-N snapshot from the log (read-gated on its own tree). The
  -- establishing insert/update event is unique per version; a delete event
  -- shares the last version but carries the same payload, so exclude it.
  select e.content, e.meta, e.tree, e.temporal, e.name
  into _content, _meta, _tree, _temporal, _name
  from {{schema}}.memory_event e
  where e.memory_id = _id
  and e.version = _version
  and e.operation <> 'delete'
  and {{schema}}.has_tree_access(_tree_access, e.tree, 1)
  order by e.at
  limit 1
  ;

  if not found then
    return false;  -- unknown / unreadable / retention-dropped version
  end if;

  -- 2. the live row, if any (locked so a concurrent write can't race the revert)
  select m.tree, m.version_hash into _cur_tree, _cur_hash
  from {{schema}}.memory m
  where m.id = _id
  for update
  ;

  if found then
    -- LIVE revert: write on the current tree AND the snapshot tree. No
    -- `_cur_tree @> _tree` short-circuit is needed: given write on the current
    -- tree, a grant that covers it also covers any descendant snapshot tree, so
    -- has_tree_access on the snapshot tree is already satisfied in that case.
    if not (
      {{schema}}.has_tree_access(_tree_access, _cur_tree, 2)
      and {{schema}}.has_tree_access(_tree_access, _tree, 2)
    ) then
      raise exception 'insufficient tree access'
        using errcode = 'insufficient_privilege';
    end if;

    if _expected_version_hash is not null
       and _cur_hash is distinct from _expected_version_hash then
      raise exception 'stale version hash'
        using errcode = 'ME002';
    end if;

    -- trigger updates content_version and version
    update {{schema}}.memory m set
      content = _content
    , meta = _meta
    , tree = _tree
    , temporal = _temporal
    , name = _name
    where m.id = _id
    ;
    return true;
  end if;

  -- 3. DELETED: undelete by re-inserting the snapshot, continuing the version
  -- sequence (memory_before_insert no longer forces version = 1). Needs write on
  -- the snapshot tree; a reused (tree, name) slot raises 23505 → CONFLICT.
  if not {{schema}}.has_tree_access(_tree_access, _tree, 2) then
    raise exception 'insufficient tree access'
      using errcode = 'insufficient_privilege';
  end if;

  -- Continue BOTH sequences from history: `version` (logical payload) and
  -- `content_version` (the embedding-queue guard token). Resetting content_version
  -- to the default 1 could collide with a pre-delete version still in flight in
  -- the embedding worker, letting a stale embedding win the version-guarded
  -- write-back (complete_embedding matches on content_version).
  select coalesce(max(e.version), 0) + 1
       , coalesce(max(e.content_version), 0) + 1
  into _next_version, _next_content_version
  from {{schema}}.memory_event e
  where e.memory_id = _id
  ;

  insert into {{schema}}.memory
    (id, tree, content, meta, temporal, name, version, content_version)
  values
    (_id, _tree, _content, _meta, _temporal, _name, _next_version, _next_content_version)
  ;
  return true;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}
