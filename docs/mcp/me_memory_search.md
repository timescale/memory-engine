# me_memory_search

Search and browse memories using text matching and/or filters.

Supports three search modes: **semantic** (meaning-based), **fulltext** (keyword-based via BM25), or **hybrid** (both combined via Reciprocal Rank Fusion). Choose the mode deliberately: use semantic search for concepts and intent, fulltext for exact words or identifiers, and hybrid when both kinds of matching are useful. Combine any search mode with tree, structured metadata, JSONPath metadata predicate, temporal, and regex filters.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `space` | `string` | varies | Absent in locked mode; required nonempty string in multi-space mode. It selects the same-server space for this call. |
| `semantic` | `string \| null` | no | Natural language query for semantic search. Omit or pass `null` to skip. |
| `fulltext` | `string \| null` | no | Keywords/phrases for BM25 exact matching. Omit or pass `null` to skip. |
| `grep` | `string \| null` | no | POSIX regex pattern filter on content (case-insensitive). Must accompany semantic/fulltext search or a `tree`, `meta`, or `temporal` filter; `metaPredicate` alone does not qualify. Omit or pass `null` to skip. |
| `meta` | `object \| null` | no | Filter by metadata attributes. Omit or pass `null` to skip. |
| `metaPredicate` | `string \| null` | no | PostgreSQL JSONPath Boolean predicate evaluated against metadata with `@@`. Omit or pass `null` to skip. |
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
| `before` | `string \| null` | no | Find memories strictly before this point in time. |
| `after` | `string \| null` | no | Find memories strictly after this point in time. |
| `contains` | `string \| null` | no | Find memories whose time range contains this point in time. |
| `overlaps` | `object \| null` | no | Find memories overlapping this range (`{start, end}`). |
| `within` | `object \| null` | no | Find memories fully within this range (`{start, end}`). |

`before` and `after` are strict and exclude memories without a temporal range.
A half-open range ending exactly at `before` matches; a range beginning at or
containing the point does not.

### metaPredicate

Use `metaPredicate` for metadata conditions that structured `meta` containment
cannot express:

```text
$.priority >= 3
$.status == "active" || $.status == "pending"
!exists($.archivedAt)
exists($.grants[*] ? (@.user == "tom" && @.level >= 2))
```

The expression must produce one Boolean result and uses PostgreSQL's SQL/JSON
path dialect. When both `meta` and `metaPredicate` are provided, both must match.
Prefer `meta` for exact values and array membership. Equality clauses can use
the metadata GIN index; other predicates may require broader scans.

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

- Provide at least one of `semantic`, `fulltext`, or a filter (`tree`, `meta`, `metaPredicate`, `temporal`, `grep`) -- otherwise the search has no criteria. `grep` must also accompany semantic/fulltext search or a `tree`, `meta`, or `temporal` filter; `metaPredicate` alone does not satisfy this guard.
- Optional parameters may be omitted or explicitly passed as `null` — both are treated as "no value".
- Omit `select` or pass `null` to receive complete memory objects. An empty selection or multiple distinct content slices are invalid.
- Selectors use camelCase response names, such as `id`, `tree`, `hasEmbedding`, and `versionHash`. The complete suffix after `meta.` is the metadata key, including `$thread` or punctuation. `content:N` returns the first `N` UTF-16 code units; `content:M:N` returns the zero-based range `[M, N)`; `content:M:` returns from `M` through the end. Content slices include the full UTF-16 `contentLength`.
- When both `semantic` and `fulltext` are provided, results are ranked using Reciprocal Rank Fusion (hybrid mode). Use this when both meaning-based similarity and exact-term matching are useful for the same query.
- `order_by` only applies to filter-only searches (no `semantic`/`fulltext`). Ranked searches are always sorted by score.
- Each result's `score` is mode-dependent and only comparable within one result set (not across modes or queries):
  - **Semantic** (`semantic` only): cosine similarity in `[-1, 1]` — higher is more similar (`1` = identical direction).
  - **Fulltext** (`fulltext` only): a positive, unnormalized BM25 score (`> 0`, unbounded — it can exceed `1`). Only genuine term matches are returned.
  - **Hybrid** (`semantic` + `fulltext`): the fused Reciprocal Rank Fusion (RRF) score — a small positive number reflecting cross-mode rank agreement, not absolute relevance.
  - **Filter-only** (neither): an unranked sentinel (`-1`); results are ordered by creation time (see `order_by`).
