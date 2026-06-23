# me_memory_update

Modify an existing memory.

Provide the ID, the current `version_hash` from a recent get/search/create/update response, and any fields to change. Omitted fields remain unchanged.

`version_hash` powers optimistic concurrency: the server applies the patch only when the supplied hash matches the stored memory's current hash. If another writer changed the memory between your read and your update, the call fails with `CONFLICT` and your patch is rejected — fetch the memory again to pick up the latest `version_hash` and retry.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | yes | The UUID of the memory to update. |
| `version_hash` | `string` | yes | The current `versionHash` of the memory (32-char md5 hex). Get it from the most recent `me_memory_get` / `me_memory_search` / `me_memory_create` / `me_memory_update` response. A stale or incorrect value fails with `CONFLICT` and does not modify the memory. |
| `content` | `string \| null` | no | New content. Omit or pass `null` to keep existing. |
| `name` | `string \| null` | no | Set or rename the leaf name. Pass an empty string (`""`) to clear it; omit or pass `null` to keep existing. Same slug rules as `me_memory_create`. |
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
  "tree": "/notes/postgres",
  "name": "uuidv7",
  "temporal": null,
  "version": 2,
  "versionHash": "9b7e4c5e8a1f3d2c6b0a4f7e8d1c2b3a",
  "hasEmbedding": true,
  "createdAt": "2025-04-15T12:00:00Z",
  "createdBy": "user_abc",
  "updatedAt": "2025-04-15T14:00:00Z"
}
```

A successful update advances `version` and returns a new `versionHash`. Use the returned `versionHash` for any subsequent update of the same memory.

See [me_memory_create](me_memory_create.md) for the full field reference.

## Example

Update only the content, passing the current `version_hash`:

```json
{
  "id": "0194a000-0001-7000-8000-000000000001",
  "version_hash": "5f3e9c2a8b1d4f7e0c3a6b9d2e5f8c1a",
  "content": "PostgreSQL 18 supports native UUIDv7 via the uuidv7() function."
}
```

## When to update vs. create new

- Core fact changed or corrected → **update** the existing memory.
- Adding context or detail to an existing idea → **update**.
- Reorganizing or reclassifying → **update** (change `tree` or `meta`).
- New distinct information, even if related → **create new** memory.

## Notes

- Always fetch the memory first (`me_memory_get`) to see the current state and capture the latest `versionHash` before updating.
- A stale `version_hash` (someone else updated the memory between your read and your write) fails with `CONFLICT` and does not modify the memory. Refetch the memory, re-apply your intent against the latest state, and retry with the new `versionHash`.
- **`meta` is fully replaced, not merged.** If you want to add a key, fetch the current meta first, merge locally, then send the full object.
- Updating `content` triggers a new embedding computation -- this is automatic, no action needed. `hasEmbedding` may temporarily become `false`.
- Omitted fields are preserved -- you can update just `tree` without touching `content`.
- `version` advances by 1 each time the logical payload (`tree`, `name`, `meta`, `temporal`, `content`) changes; `versionHash` is recomputed in the same trigger. `version` is informational; only `version_hash` is required on input.
- Returns an error if the memory does not exist.
