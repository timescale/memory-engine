
-------------------------------------------------------------------------------
-- search_memory
-------------------------------------------------------------------------------
create or replace function {{schema}}.search_memory
( _user_id uuid
, _bm25 bm25query default null
, _ltree ltree default null
, _lquery lquery default null
, _ltxtquery ltxtquery default null
, _meta_contains jsonb default null
, _temporal_contains tstzrange default null
, _temporal_overlaps tstzrange default null
, _temporal_before timestamptz default null
, _temporal_after timestamptz default null
, _regexp text default null
, _limit bigint default 10
)
returns table
( id uuid
, meta jsonb
, tree ltree
, temporal tstzrange
, content text
, has_embedding bool
, created_at timestamptz
, updated_at timestamptz
, score float8
)
as $func$
declare
  _filter_count int = 0;
  _score text;
  _filters text[] = '{}'::text;
  _order_by text;
  _sql text;
begin
  -- min 1, max 1000, default 10
  _limit = greatest(least(coalesce(_limit, 10), 1000), 1);

  -- score and order by
  case when _bm25 is not null then
    _filter_count = _filter_count + 1;
    _score = format($sql$, (m.content <@> %L::bm25query) * -1 as score$sql$, _bm25);
    _order_by = format($sql$order by m.content <@> %L::bm25query, m.id$sql$, _bm25);
  else
    _score = $sql$, -1 as score$sql$;
    _order_by = $sql$order by m.id;
  end case;

  -- ltree
  if _ltree is not null then
    _filter_count = _filter_count + 1;
    _filters = array_append
    ( _filters
    , format($sql$and %L::ltree @> m.tree$sql$, _ltree)
    );
  end if;

  -- lquery
  if _lquery is not null then
    _filter_count = _filter_count + 1;
    _filters = array_append
    ( _filters
    , format($sql$and m.tree ~ %L::lquery$sql$, _lquery)
    );
  end if;

  -- ltxtquery
  if _ltxtquery is not null then
    _filter_count = _filter_count + 1;
    _filters = array_append
    ( _filters
    , format($sql$and m.tree @ %L::ltxtquery$sql$, _ltxtquery)
    );
  end if;

  -- meta_contains
  if _meta_contains is not null then
    _filter_count = _filter_count + 1;
    _filters = array_append
    ( _filters
    , format($sql$and m.meta @> %L::jsonb$sql$, _meta_contains)
    );
  end if;

  -- temporal_contains
  if _temporal_contains is not null then
    _filter_count = _filter_count + 1;
    _filters = array_append
    ( _filters
    , format($sql$and %L::tstzrange @> m.temporal$sql$, _temporal_contains)
    );
  end if;

  -- temporal_overlaps
  if _temporal_overlaps is not null then
    _filter_count = _filter_count + 1;
    _filters = array_append
    ( _filters
    , format($sql$and %L::tstzrange && m.temporal$sql$, _temporal_overlaps)
    );
  end if;

  -- temporal_before
  if _temporal_before is not null then
    _filter_count = _filter_count + 1;
    _filters = array_append
    ( _filters
    , format($sql$and m.temporal << tstzrange(%L::timestamptz, %L::timestamptz, '[]')$sql$, _temporal_before, _temporal_before)
    );
  end if;

  -- temporal_after
  if _temporal_after is not null then
    _filter_count = _filter_count + 1;
    _filters = array_append
    ( _filters
    , format($sql$and tstzrange(%L::timestamptz, %L::timestamptz, '[]') << m.temporal$sql$, _temporal_after, _temporal_after)
    );
  end if;

  -- regexp
  if _regexp is not null then
    if _filter_count = 0 then
      raise exception 'regexp must not be the only filter criteria'
        using errcode = 'invalid_parameter_value';
    end if;
    _filters = array_append
    ( _filters
    , format($sql$and m.content ~* %L::text$sql$, _regexp)
    );
  end if;

  -- construct the query
  _sql = format(
  $sql$
  with x as
  (
    select a.tree_path
    from {{schema}}.calc_tree_access($1) a
    where a.access >= 1
  )
  select
    m.id
  , m.meta
  , m.tree
  , m.temporal
  , m.content
  , m.embedding is not null
  , m.created_at
  , m.updated_at
  %s
  from {{schema}}.memory m
  where exists
  (
    select 1
    from x
    where x.tree_path @> m.tree
  )
  %s
  %s
  limit $2
  $sql$
  , _score
  , (
      select string_agg(x, E'\n  ')
      from unnest(_filters) x
    )
  , _order_by
  );

  return query execute _sql using _user_id, _limit;
end;
$func$ language plpgsql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
