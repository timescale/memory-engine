# me_memory_search

Search and browse memories using text matching and/or filters.

Supports three search modes: **semantic** (meaning-based), **fulltext** (keyword-based via BM25), or **hybrid** (both combined via Reciprocal Rank Fusion). Combine any search mode with tree, meta, and temporal filters.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `semantic` | `string \| null` | yes | Natural language query for semantic search. Pass `null` to skip. |
| `fulltext` | `string \| null` | yes | Keywords/phrases for BM25 exact matching. Pass `null` to skip. |
| `grep` | `string \| null` | yes | POSIX regex pattern filter on content (case-insensitive). Applied as a WHERE filter alongside other filters. Pass `null` to skip. |
| `meta` | `object \| null` | yes | Filter by metadata attributes. Pass `null` to skip. |
| `tree` | `string \| null` | yes | Filter by tree path. Pass `null` to skip. |
| `temporal` | `object \| null` | yes | Temporal filter. Pass `null` to skip. |
| `weights` | `object \| null` | yes | Weights for hybrid search ranking. Pass `null` for defaults. |
| `candidateLimit` | `integer` | yes | Candidates per search mode before RRF fusion. Pass `0` for default (30). |
| `limit` | `integer` | yes | Maximum number of results. Pass `0` for default (10). Max: 1000. |
| `order_by` | `string \| null` | yes | Sort direction for filter-only searches: `"asc"` or `"desc"`. Default: `"desc"`. Pass `null` for default. |

### tree syntax

- Bare path (`work.projects`) -- matches that exact node only.
- Wildcard (`work.projects.*`) -- matches all descendants.
- lquery pattern (`*.api.*`) -- matches any path containing `api`.
- ltxtquery (`api & v2`) -- label search with boolean operators.

### temporal

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `contains` | `string \| null` | yes | Find memories whose time range contains this point in time. |
| `overlaps` | `object \| null` | yes | Find memories overlapping this range (`{start, end}`). |
| `within` | `object \| null` | yes | Find memories fully within this range (`{start, end}`). |

### weights

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `fulltext` | `number \| null` | yes | Weight for BM25 keyword matching (0-1). |
| `semantic` | `number \| null` | yes | Weight for semantic similarity (0-1). |

## Returns

```json
{
  "results": [
    {
      "id": "0194a000-0001-7000-8000-000000000001",
      "content": "Use ltree for hierarchical path queries.",
      "meta": { "source": "docs" },
      "tree": "research.postgres",
      "temporal": null,
      "hasEmbedding": true,
      "createdAt": "2025-04-15T12:00:00Z",
      "createdBy": "user_abc",
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
| `results` | `array` | Array of memory objects, each with an additional `score` field (0-1). |
| `total` | `number` | Total number of matching memories. |
| `limit` | `number` | The limit that was applied. |

## Examples

### Semantic search

```json
{
  "semantic": "how does authentication work",
  "fulltext": null,
  "grep": null,
  "meta": null,
  "tree": null,
  "temporal": null,
  "weights": null,
  "candidateLimit": 0,
  "limit": 10,
  "order_by": null
}
```

### Hybrid search with tree filter

```json
{
  "semantic": "embedding performance",
  "fulltext": "nomic ollama",
  "grep": null,
  "meta": null,
  "tree": "me.design.*",
  "temporal": null,
  "weights": null,
  "candidateLimit": 0,
  "limit": 5,
  "order_by": null
}
```

### Filter-only browse (no search)

```json
{
  "semantic": null,
  "fulltext": null,
  "grep": null,
  "meta": { "type": "decision" },
  "tree": "me.strategy.*",
  "temporal": null,
  "weights": null,
  "candidateLimit": 0,
  "limit": 20,
  "order_by": "desc"
}
```

## Notes

- Provide at least one of `semantic`, `fulltext`, or a filter (`tree`, `meta`, `temporal`, `grep`) -- otherwise the search has no criteria.
- When both `semantic` and `fulltext` are provided, results are ranked using Reciprocal Rank Fusion (hybrid mode).
- `order_by` only applies to filter-only searches (no `semantic`/`fulltext`). Ranked searches are always sorted by score.
- `score` ranges from 0 to 1, where 1 is the best match.
