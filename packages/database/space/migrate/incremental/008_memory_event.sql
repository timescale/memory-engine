-------------------------------------------------------------------------------
-- memory_event
-------------------------------------------------------------------------------
create table {{schema}}.memory_event
( event_id uuid not null default uuidv7()
, at timestamptz not null default clock_timestamp()
, memory_id uuid not null
, operation text not null check (operation in ('insert','update','delete'))
, operation_id uuid not null
, cause text
, actor jsonb not null default '{}' check (jsonb_typeof(actor)='object')
, tree ltree not null
, name text
, meta jsonb not null
, temporal tstzrange
, content text not null
, content_version integer not null
, version bigint not null
, version_hash text not null
, primary key (memory_id, at, event_id)
);

-- entity-lookup indexes (cheap per-chunk probes on the hypertable)
create index memory_event_tree_gist_idx on {{schema}}.memory_event using gist (tree);
create index memory_event_tree_name_idx on {{schema}}.memory_event (tree, name) where name is not null;
create index memory_event_memory_id_version_idx on {{schema}}.memory_event (memory_id, version desc);
create index memory_event_operation_id_idx on {{schema}}.memory_event (operation_id);
-- time index for the date-oriented feed (since/until) — created explicitly so it
-- exists whether or not timescaledb is installed (create_default_indexes => false).
create index memory_event_at_idx on {{schema}}.memory_event (at desc);

-- convert memory_event to a hypertable if timescaledb is installed
do $block$
begin
  -- is timescaledb installed?
  perform
  from pg_catalog.pg_extension
  where extname = 'timescaledb'
  ;
  if not found then
    -- not installed. bail.
    return;
  end if;

  -- timescaledb is installed
  -- create the hypertable (we manage our own indexes above)
  perform public.create_hypertable
  ( '{{schema}}.memory_event'::regclass
  , public.by_range('at', interval '1 month')
  , if_not_exists => true
  , create_default_indexes => false
  );

  -- drop audit events older than 30 days (per-memory history is bounded to the
  -- retention window). Requires timescaledb; safe to skip on the plain-table path.
  perform public.add_retention_policy
  ( '{{schema}}.memory_event'::regclass
  , drop_after => interval '30 days'
  , if_not_exists => true
  );
end
$block$;
