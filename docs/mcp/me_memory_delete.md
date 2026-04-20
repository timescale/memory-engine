# me_memory_delete

Permanently remove a memory by ID.

This is irreversible. Consider archiving (via a meta update) or moving (via `me_memory_mv`) instead.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | yes | The UUID of the memory to delete. |

## Returns

```json
{
  "deleted": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `deleted` | `boolean` | `true` if the memory was deleted. |

## Example

```json
{
  "id": "0194a000-0001-7000-8000-000000000001"
}
```

## Notes

- Deleting a non-existent memory returns an error.
- This operation is irreversible. There is no undo.
