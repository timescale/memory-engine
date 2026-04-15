# me_memory_update

Modify an existing memory.

Provide the ID and any fields to change. Fields set to `null` remain unchanged.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | yes | The UUID of the memory to update. |
| `content` | `string \| null` | yes | New content. Pass `null` to keep existing. |
| `meta` | `object \| null` | yes | New metadata. Pass `null` to keep existing. |
| `tree` | `string \| null` | yes | New tree path. Pass `null` to keep existing. |
| `temporal` | `object \| null` | yes | New time range. Pass `null` to keep existing. |

### temporal

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `start` | `string` | yes | ISO 8601 timestamp for the start of the time range. |
| `end` | `string \| null` | yes | ISO 8601 timestamp for the end. Pass `null` for a point-in-time memory. |

## Returns

The full updated memory object:

```json
{
  "id": "0194a000-0001-7000-8000-000000000001",
  "content": "Updated content here.",
  "meta": { "topic": "database", "reviewed": true },
  "tree": "notes.postgres",
  "temporal": null,
  "hasEmbedding": true,
  "createdAt": "2025-04-15T12:00:00Z",
  "createdBy": "user_abc",
  "updatedAt": "2025-04-15T14:00:00Z"
}
```

See [me_memory_create](me_memory_create.md) for the full field reference.

## Example

Update only the content, keep everything else:

```json
{
  "id": "0194a000-0001-7000-8000-000000000001",
  "content": "PostgreSQL 18 supports native UUIDv7 via the uuidv7() function.",
  "meta": null,
  "tree": null,
  "temporal": null
}
```

## Notes

- **`meta` is fully replaced, not merged.** If you want to add a key, fetch the current meta first, merge locally, then send the full object.
- Updating content triggers a new embedding computation. `hasEmbedding` may temporarily become `false`.
- Returns an error if the memory does not exist.
