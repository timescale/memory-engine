# me_memory_update

Modify an existing memory.

Provide the ID and any fields to change. Omitted fields remain unchanged.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | yes | The UUID of the memory to update. |
| `content` | `string \| null` | no | New content. Omit or pass `null` to keep existing. |
| `meta` | `object \| null` | no | New metadata. Omit or pass `null` to keep existing. |
| `tree` | `string \| null` | no | New tree path. Omit or pass `null` to keep existing. |
| `temporal` | `object \| null` | no | New time range. Omit or pass `null` to keep existing. |

### temporal

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `start` | `string` | yes | ISO 8601 timestamp for the start of the time range. |
| `end` | `string \| null` | no | ISO 8601 timestamp for the end. Omit or pass `null` for a point-in-time memory. |

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
  "content": "PostgreSQL 18 supports native UUIDv7 via the uuidv7() function."
}
```

## When to update vs. create new

- Core fact changed or corrected → **update** the existing memory.
- Adding context or detail to an existing idea → **update**.
- Reorganizing or reclassifying → **update** (change `tree` or `meta`).
- New distinct information, even if related → **create new** memory.

## Notes

- Always fetch the memory first (`me_memory_get`) to see the current state before updating.
- **`meta` is fully replaced, not merged.** If you want to add a key, fetch the current meta first, merge locally, then send the full object.
- Updating `content` triggers a new embedding computation -- this is automatic, no action needed. `hasEmbedding` may temporarily become `false`.
- Omitted fields are preserved -- you can update just `tree` without touching `content`.
- Returns an error if the memory does not exist.
