# me_memory_delete

Permanently remove a memory by ID.

This is irreversible. Consider archiving (via a meta update) or moving (via `me_memory_mv`) instead. To delete a named memory by its `tree/name` path use [me_memory_delete_by_path](me_memory_delete_by_path.md); to remove a whole subtree use [me_memory_delete_tree](me_memory_delete_tree.md).

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `space` | `string` | varies | Absent in locked mode; required nonempty string in multi-space mode. It selects the same-server space for this call. |
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
