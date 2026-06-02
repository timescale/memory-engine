-------------------------------------------------------------------------------
-- search_memory
-------------------------------------------------------------------------------
create or replace function {{schema}}.search_memory
( _tree_access jsonb
, _bm25 bm25query default null
, _vec halfvec({{embedding_dimensions}}) default null
, _max_vec_dist float8 default null
, _ltree ltree default null
, _lquery lquery default null
, _ltxtquery ltxtquery default null
, _meta_contains jsonb default null
, _temporal_within tstzrange default null
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
  -- _bm25 OR _vec but NOT BOTH
  if _bm25 is not null and _vec is not null then
    raise exception 'providing both _bm25 and _vec is not supported'
      using errcode = 'invalid_parameter_value';
  end if;

  if _max_vec_dist is not null and _vec is null then
    raise exception '_max_vec_dist provided but _vec was not provided'
      using errcode = 'invalid_parameter_value';
  end if;

  -- min 1, max 1000, default 10
  _limit = greatest(least(coalesce(_limit, 10), 1000), 1);

  -- bm25 or semantic
  -- score and order by
  case
  when _bm25 is not null then
    _filter_count = _filter_count + 1;
    -- <@> is negative bm25 score. smaller values means better match. order by this for index scans
    -- negative score * -1 = score. higher score means better match
    _score = format($sql$, (m.content <@> %L::bm25query) * -1 as score$sql$, _bm25);
    _order_by = format($sql$order by m.content <@> %L::bm25query, m.id$sql$, _bm25);
  when _vec is not null then
    _filter_count = _filter_count + 1;
    -- <=> is cosine distance. smaller distance means better match. order by this for index scans
    -- distance * -1 = "score". higher score means better match
    _score = format($sql$, (m.embedding <=> %L::halfvec({{embedding_dimensions}})) * -1 as score$sql$, _vec);
    _order_by = format($sql$order by m.embedding <=> %L::halfvec({{embedding_dimensions}}), m.id$sql$, _vec);
    _filters = array_append
    ( _filters
    , $sql$and m.embedding is not null$sql$
    );
    if _max_vec_dist is not null then
      _filter_count = _filter_count + 1;
      _filters = array_append
      ( _filters
      , format($sql$and (m.embedding <=> %L::halfvec({{embedding_dimensions}})) <= %L::float8$sql$, _vec, _max_vec_dist)
      );
    end if;
  else
    _score = $sql$, -1 as score$sql$;
    _order_by = $sql$order by m.id$sql$;
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

  -- temporal_within
  if _temporal_within is not null then
    _filter_count = _filter_count + 1;
    _filters = array_append
    ( _filters
    , format($sql$and %L::tstzrange @> m.temporal$sql$, _temporal_within)
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
    , format($sql$and tstzrange('-infinity'::timestamptz, %L::timestamptz, '[]') @> m.temporal$sql$, _temporal_before)
    );
  end if;

  -- temporal_after
  if _temporal_after is not null then
    _filter_count = _filter_count + 1;
    _filters = array_append
    ( _filters
    , format($sql$and tstzrange(%L::timestamptz, 'infinity'::timestamptz, '[]') @> m.temporal$sql$, _temporal_after)
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
  with x as materialized
  (
    select x.tree_path
    from jsonb_to_recordset($1) x(tree_path ltree, access int)
    where x.access >= 1
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
  , coalesce
    (
      (
        select string_agg(x, E'\n  ')
        from unnest(_filters) x
      )
    , ''
    )
  , _order_by
  );

  return query execute _sql using _tree_access, _limit;
end;
$func$ language plpgsql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- hybrid_search_memory
-------------------------------------------------------------------------------
create or replace function {{schema}}.hybrid_search_memory
( _tree_access jsonb
, _bm25 bm25query
, _vec halfvec({{embedding_dimensions}})
, _max_vec_dist float8 default null
, _ltree ltree default null
, _lquery lquery default null
, _ltxtquery ltxtquery default null
, _meta_contains jsonb default null
, _temporal_within tstzrange default null
, _temporal_overlaps tstzrange default null
, _temporal_before timestamptz default null
, _temporal_after timestamptz default null
, _regexp text default null
, _k float8 default 60.0
, _candidate_limit bigint default 30
, _fulltext_weight float8 default 1.0
, _semantic_weight float8 default 1.0
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
begin
  if _bm25 is null then
    raise exception '_bm25 must not be null'
      using errcode = 'invalid_parameter_value';
  end if;

  if _vec is null then
    raise exception '_vec must not be null'
      using errcode = 'invalid_parameter_value';
  end if;

  _k = greatest(coalesce(_k, 60.0), 0.0);
  _limit = greatest(least(coalesce(_limit, 10), 1000), 1);
  _candidate_limit = greatest
    ( least(coalesce(_candidate_limit, 30), 1000)
    , _limit
    );
  _fulltext_weight = greatest(least(coalesce(_fulltext_weight, 1.0), 1.0), 0.0);
  _semantic_weight = greatest(least(coalesce(_semantic_weight, 1.0), 1.0), 0.0);

  -- reciprocal rank fusion
  return query
  select
    coalesce(x1.id, x2.id) as id
  , coalesce(x1.meta, x2.meta) as meta
  , coalesce(x1.tree, x2.tree) as tree
  , coalesce(x1.temporal, x2.temporal) as temporal
  , coalesce(x1.content, x2.content) as content
  , coalesce(x1.has_embedding, x2.has_embedding) as has_embedding
  , coalesce(x1.created_at, x2.created_at) as created_at
  , coalesce(x1.updated_at, x2.updated_at) as updated_at
  ,   coalesce(_fulltext_weight / (_k + x1.rank), 0.0)
    + coalesce(_semantic_weight / (_k + x2.rank), 0.0) as score
  from
  (
    select
      row_number() over (order by m.score desc, m.id) as rank
    , m.*
    from {{schema}}.search_memory
    ( _tree_access => _tree_access
    , _bm25 => _bm25
    , _ltree => _ltree
    , _lquery => _lquery
    , _ltxtquery => _ltxtquery
    , _meta_contains => _meta_contains
    , _temporal_within => _temporal_within
    , _temporal_overlaps => _temporal_overlaps
    , _temporal_before => _temporal_before
    , _temporal_after => _temporal_after
    , _regexp => _regexp
    , _limit => _candidate_limit
    ) m
  ) x1
  full outer join
  (
    select
      row_number() over (order by m.score desc, m.id) as rank
    , m.*
    from {{schema}}.search_memory
    ( _tree_access => _tree_access
    , _vec => _vec
    , _max_vec_dist => _max_vec_dist
    , _ltree => _ltree
    , _lquery => _lquery
    , _ltxtquery => _ltxtquery
    , _meta_contains => _meta_contains
    , _temporal_within => _temporal_within
    , _temporal_overlaps => _temporal_overlaps
    , _temporal_before => _temporal_before
    , _temporal_after => _temporal_after
    , _regexp => _regexp
    , _limit => _candidate_limit
    ) m
  ) x2 on (x1.id = x2.id)
  order by score desc, id
  limit _limit
  ;
end;
$func$ language plpgsql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
