# me_memory_search

Search and browse memories using text matching and/or filters.

Supports three search modes: **semantic** (meaning-based), **fulltext** (keyword-based via BM25), or **hybrid** (both combined via Reciprocal Rank Fusion). Choose the mode deliberately: use semantic search for concepts and intent, fulltext for exact words or identifiers, and hybrid when both kinds of matching are useful. Combine any search mode with tree, meta, and temporal filters.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `space` | `string` | varies | Absent in locked mode; required nonempty string in multi-space mode. It selects the same-server space for this call. |
| `semantic` | `string \| null` | no | Natural language query for semantic search. Omit or pass `null` to skip. |
| `fulltext` | `string \| null` | no | Keywords/phrases for BM25 exact matching. Omit or pass `null` to skip. |
| `grep` | `string \| null` | no | POSIX regex pattern filter on content (case-insensitive). Applied as a WHERE filter alongside other filters. Omit or pass `null` to skip. |
| `meta` | `object \| null` | no | Filter by metadata attributes. Omit or pass `null` to skip. |
| `tree` | `string \| null` | no | Filter by tree path. Omit or pass `null` to skip. |
| `temporal` | `object \| null` | no | Temporal filter. Omit or pass `null` to skip. |
| `weights` | `object \| null` | no | Weights for hybrid search ranking. Omit or pass `null` for defaults. |
| `candidateLimit` | `integer \| null` | no | Candidates per search mode before RRF fusion. Omit or pass `null` for default (30). |
| `semanticThreshold` | `number \| null` | no | Minimum cosine similarity, in `[0, 1]` (1 = identical, 0 = unrelated), for semantic/vector candidates. Higher is stricter. Values outside `[0, 1]` are rejected, not clamped. Omit or pass `null` to skip. |
| `limit` | `integer \| null` | no | Maximum number of results. Omit or pass `null` for default (10). Max: 1000. |
| `order_by` | `string \| null` | no | Sort direction for filter-only searches: `"asc"` or `"desc"`. Default: `"desc"`. Omit or pass `null` for default. |
| `select` | `string[] \| null` | no | Fields to present for each result. Omit or pass `null` for complete memory objects. Supports response fields, `meta.keyName`, and content slices. |
| `format` | `"yaml" \| "json" \| "compact" \| null` | no | Text serialization format. Omit or pass `null` for YAML; `json` and `compact` both return compact JSON. |

### tree syntax

The system auto-detects the syntax from the pattern. Quick reference:

- Bare path (`/work/projects`) -- matches that node and all descendants.
- Wildcard (`/work/projects/*`) -- all descendants at any depth.
- Depth-limited (`/work/*{2}`) -- descendants up to 2 levels deep.
- Negation (`*/!draft/*`) -- paths that do NOT contain `draft`.
- Pattern (`*/api/*`) -- any path containing `api`.
- Label search (`api & v2`) -- boolean search over path labels.

See [Tree filter syntax](../concepts.md#tree-filter-syntax) for the full reference with examples.

### temporal

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `contains` | `string \| null` | no | Find memories whose time range contains this point in time. |
| `overlaps` | `object \| null` | no | Find memories overlapping this range (`{start, end}`). |
| `within` | `object \| null` | no | Find memories fully within this range (`{start, end}`). |

### weights

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `fulltext` | `number \| null` | no | Weight for BM25 keyword matching (0-1). |
| `semantic` | `number \| null` | no | Weight for semantic similarity (0-1). |

## Returns

The tool returns YAML by default. The JSON below illustrates the response shape;
pass `format: "json"` or `format: "compact"` for compact JSON text.

```json
{
  "results": [
    {
      "id": "0194a000-0001-7000-8000-000000000001",
      "content": "Use ltree for hierarchical path queries.",
      "meta": { "source": "docs" },
      "tree": "/research/postgres",
      "name": null,
      "temporal": null,
      "version": 1,
      "versionHash": "5f3e9c2a8b1d4f7e0c3a6b9d2e5f8c1a",
      "hasEmbedding": true,
      "createdAt": "2025-04-15T12:00:00Z",
      "createdBy": null,
      "updatedAt": null,
      "score": 0.85
    }
  ],
  "total": 1,
  "limit": 10
}
```

| Field | Type | Description |
|-------|------|-------------|
| `results` | `array` | Array of memory objects (same shape as `me_memory_get`, including `version` and `versionHash`), each with an additional mode-dependent `score`. |
| `total` | `number` | Total number of matching memories. |
| `limit` | `number` | The limit that was applied. |

## Examples

### Semantic search

```json
{
  "semantic": "how does authentication work",
  "limit": 10
}
```

### Hybrid search

```json
{
  "semantic": "panics",
  "fulltext": "panics",
  "limit": 10
}
```

### Hybrid search with tree filter

```json
{
  "semantic": "embedding performance",
  "fulltext": "nomic ollama",
  "tree": "/share/design/*",
  "limit": 5
}
```

### Filter-only browse (no search)

```json
{
  "meta": { "type": "decision" },
  "tree": "/share/strategy/*",
  "limit": 20,
  "order_by": "desc"
}
```

## Notes

- Provide at least one of `semantic`, `fulltext`, or a filter (`tree`, `meta`, `temporal`, `grep`) -- otherwise the search has no criteria.
- Optional parameters may be omitted or explicitly passed as `null` — both are treated as "no value".
- Omit `select` or pass `null` to receive complete memory objects. An empty selection or multiple distinct content slices are invalid.
- Selectors use camelCase response names, such as `id`, `tree`, `hasEmbedding`, and `versionHash`. The complete suffix after `meta.` is the metadata key, including `$thread` or punctuation. `content:N` returns the first `N` UTF-16 code units; `content:M:N` returns the zero-based range `[M, N)`; `content:M:` returns from `M` through the end. Content slices include the full UTF-16 `contentLength`.
- When both `semantic` and `fulltext` are provided, results are ranked using Reciprocal Rank Fusion (hybrid mode). Use this when both meaning-based similarity and exact-term matching are useful for the same query.
- `order_by` only applies to filter-only searches (no `semantic`/`fulltext`). Ranked searches are always sorted by score.
- Scores are mode-dependent and only comparable within one result set. Filter-only searches use `-1`; BM25, semantic, and hybrid searches use their respective ranking scales.
