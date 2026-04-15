# me_memory_get

Retrieve a single memory by its ID.

Returns the full memory including content, tree, meta, temporal, and embedding status. Use after search to get full details, or before update to see current state.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | yes | The UUID of the memory to retrieve. |

## Returns

The full memory object:

```json
{
  "id": "0194a000-0001-7000-8000-000000000001",
  "content": "PostgreSQL 18 supports native UUID v7 generation.",
  "meta": { "topic": "database" },
  "tree": "notes.postgres",
  "temporal": null,
  "hasEmbedding": true,
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
| `hasEmbedding` | `boolean` | Whether a vector embedding has been computed. |
| `createdAt` | `string` | ISO 8601 creation timestamp. |
| `createdBy` | `string \| null` | The user that created the memory. |
| `updatedAt` | `string \| null` | ISO 8601 timestamp of last update, or `null`. |

## Example

```json
{
  "id": "0194a000-0001-7000-8000-000000000001"
}
```

## Notes

- Returns an error if the memory does not exist or the caller lacks access.
- Useful for fetching the current state before performing an update.
