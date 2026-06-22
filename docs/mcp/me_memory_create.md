# me_memory_create

Store a new memory.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string \| null` | no | UUIDv7 to preserve identity (import/export). Omit or pass `null` to auto-generate. |
| `content` | `string` | yes | The content of the memory. Must be non-empty. |
| `name` | `string \| null` | no | Optional filename-like leaf slug, unique within the tree (e.g. `jwt-rotation`). Matches `^[A-Za-z0-9][A-Za-z0-9._-]*$`, ≤128 chars -- dots allowed, no slashes. Lets the memory be addressed as `/share/auth/jwt-rotation`. Omit or pass `null` for an unnamed memory. |
| `meta` | `object \| null` | no | Key-value metadata pairs. Omit or pass `null` to skip. |
| `tree` | `string` | yes | Hierarchical path where the memory is stored (e.g., `/share/work/projects`). The canonical form is `/`-separated with a leading slash (the leading slash is optional on input). Choose deliberately: most memories should go under `/share` so the rest of the space can see them; use `~` (your private home, e.g. `~/notes`) only for memories that must stay private to you. |
| `temporal` | `object \| null` | no | Time range for the memory. Omit or pass `null` to skip. |
| `on_conflict` | `string \| null` | no | What to do when the idempotency key (a named memory's `(tree, name)` slot, which takes precedence over any `id`; else the explicit `id`) already exists: `"error"` (default -- raise CONFLICT), `"replace"` (overwrite in place when content/meta/temporal differ; a no-op when identical), or `"ignore"` (skip and return the existing memory). |

### temporal

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `start` | `string` | yes | ISO 8601 timestamp for the start of the time range. |
| `end` | `string \| null` | no | ISO 8601 timestamp for the end. Omit or pass `null` for a point-in-time memory. |

## Returns

The full memory object as created:

```json
{
  "id": "0194a000-0001-7000-8000-000000000001",
  "content": "PostgreSQL 18 supports native UUID v7 generation.",
  "meta": { "topic": "database" },
  "tree": "/notes/postgres",
  "name": "uuidv7",
  "temporal": null,
  "hasEmbedding": false,
  "createdAt": "2025-04-15T12:00:00Z",
  "createdBy": "user_abc",
  "updatedAt": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | UUIDv7 identifier. |
| `content` | `string` | The memory content. |
| `meta` | `object` | Metadata key-value pairs (empty `{}` if none). |
| `tree` | `string` | Tree path (canonical `/`-form; `/` if root). |
| `name` | `string \| null` | The leaf name, or `null` if unnamed. |
| `temporal` | `object \| null` | Time range with `start` and `end`, or `null`. |
| `hasEmbedding` | `boolean` | Whether a vector embedding has been computed yet. |
| `createdAt` | `string` | ISO 8601 creation timestamp. |
| `createdBy` | `string \| null` | The user that created the memory. |
| `updatedAt` | `string \| null` | ISO 8601 timestamp of last update, or `null`. |

## Example

```json
{
  "content": "Use ltree for hierarchical path queries in PostgreSQL.",
  "meta": { "source": "docs", "confidence": "high" },
  "tree": "/research/postgres",
  "name": "ltree-paths",
  "temporal": {
    "start": "2025-04-15T00:00:00Z"
  }
}
```

## Notes

- **One idea per memory.** Three decisions = three memories. Search first to avoid duplicates.
- Tree labels match `[A-Za-z0-9_-]` (letters, digits, `_`, `-`) and are `/`-separated. A memory's `name` is a separate leaf that additionally allows dots.
- By default a conflict on the idempotency key (a named memory's `(tree, name)` slot, which takes precedence over any `id`; else the explicit `id`) raises `CONFLICT`. Pass `on_conflict: "ignore"` to make the call idempotent (returns the existing memory) or `"replace"` to overwrite in place when something differs. This governs the idempotency-key conflict only — a named memory whose `id` collides with a *different* existing row still raises regardless of `on_conflict`.
- `meta` is fully replaced, not merged. Store the complete metadata object each time. Values support any JSON type (strings, numbers, arrays, nested objects).
- Embeddings are computed asynchronously after creation. `hasEmbedding` will be `false` initially. Fulltext search works immediately; semantic search is available after ~10-30 seconds.
