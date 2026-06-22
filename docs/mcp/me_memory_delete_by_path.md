# me_memory_delete_by_path

Permanently remove a single named memory by its `tree/name` path
(e.g. `/share/auth/jwt-rotation`).

Deletes only that one named memory. Use `me_memory_delete_tree` to remove a
whole subtree, or `me_memory_delete` to delete by UUID.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | yes | The `tree/name` path, e.g. `/share/auth/jwt-rotation`. |

## Returns

```json
{ "deleted": true }
```

## Notes

- Irreversible.
- Returns NOT_FOUND if no named memory matches the path.
