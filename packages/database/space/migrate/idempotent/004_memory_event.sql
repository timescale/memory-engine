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
-- least one of _memory_id / _tree / _operation_id (enforced at the RPC layer).
-- Deleted memories remain visible (their tombstone events outlive the row).
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
  -- date window (chunk-pruned on the hypertable)
  and (_since is null or e.at >= _since)
  and (_until is null or e.at < _until)
  -- keyset cursor on event_id: uuidv7 is unique and co-monotonic with `at`, so a
  -- single-column seek is exact (no timestamp-precision loss) and matches the
  -- (at, event_id) sort order below.
  and (
    _cursor_event_id is null
    or (_order = 'desc' and e.event_id < _cursor_event_id)
    or (_order = 'asc' and e.event_id > _cursor_event_id)
  )
  order by
    case when _order = 'asc' then e.at end asc
  , case when _order = 'desc' then e.at end desc
  , case when _order = 'asc' then e.event_id end asc
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
