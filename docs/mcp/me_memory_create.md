# me_memory_create

Store a new memory.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string \| null` | no | UUIDv7 for idempotent creates. Omit or pass `null` to auto-generate. |
| `content` | `string` | yes | The content of the memory. Must be non-empty. |
| `meta` | `object \| null` | no | Key-value metadata pairs. Omit or pass `null` to skip. |
| `tree` | `string \| null` | no | Hierarchical path using dot-separated labels (e.g., `work.projects.me`). Omit or pass `null` to store at the root. |
| `temporal` | `object \| null` | no | Time range for the memory. Omit or pass `null` to skip. |

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
  "tree": "notes.postgres",
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
| `tree` | `string` | Tree path (empty string if root). |
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
  "tree": "research.postgres",
  "temporal": {
    "start": "2025-04-15T00:00:00Z"
  }
}
```

## Notes

- **One idea per memory.** Three decisions = three memories. Search first to avoid duplicates.
- Tree labels must be lowercase alphanumeric with underscores only -- no spaces, hyphens, or uppercase (e.g., `work.my_project`, not `work.my-project`).
- When `id` is provided, the call is idempotent -- creating the same ID twice returns the existing memory.
- `meta` is fully replaced, not merged. Store the complete metadata object each time. Values support any JSON type (strings, numbers, arrays, nested objects).
- Embeddings are computed asynchronously after creation. `hasEmbedding` will be `false` initially. Fulltext search works immediately; semantic search is available after ~10-30 seconds.
