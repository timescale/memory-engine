-------------------------------------------------------------------------------
-- memory
-------------------------------------------------------------------------------
create table {{schema}}.memory
( id uuid not null primary key default uuidv7() check (uuid_extract_version(id) = 7)
, meta jsonb not null default '{}' check (jsonb_typeof(meta) = 'object')
, tree ltree not null default ''::ltree
, temporal tstzrange
, content text not null
, embedding halfvec({{embedding_dimensions}})
, embedding_version int4 not null default 1
, created_at timestamptz not null default now()
, updated_at timestamptz
);

-- index for faceted search
create index memory_meta_gin_idx on {{schema}}.memory using gin (meta);

-- index for temporal search
create index memory_temporal_gist_idx on {{schema}}.memory using gist (temporal) where (temporal is not null);

-- index for BM25 text search
create index memory_content_bm25_idx on {{schema}}.memory using bm25 (content)
with (text_config = {{bm25_text_config}}, k1 = {{bm25_k1}}, b = {{bm25_b}});

-- index for vector similarity search
create index memory_embedding_hnsw_idx on {{schema}}.memory using hnsw (embedding halfvec_cosine_ops)
with (m = {{hnsw_m}}, ef_construction = {{hnsw_ef_construction}});

-- index for hierarchical organization
create index memory_tree_gist_idx on {{schema}}.memory using gist (tree);

/*
enforce consistent temporal range conventions:
- point-in-time events: lower = upper with inclusive bounds '[same,same]'
- time periods: lower < upper with inclusive-exclusive bounds '[start,end)'
*/
alter table {{schema}}.memory add constraint temporal_bounds_convention check
(
	temporal is null
	or (
		-- point-in-time: both bounds equal and inclusive
		(lower(temporal) = upper(temporal) and lower_inc(temporal) and upper_inc(temporal))
		or
		-- time range: start before end, inclusive-exclusive
		(lower(temporal) < upper(temporal) and lower_inc(temporal) and not upper_inc(temporal))
	)
);
