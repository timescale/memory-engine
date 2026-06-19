# me_memory_get_by_path

Retrieve a single named memory by its `folder/name` path.

The last path segment is the name; the rest is the tree. For example,
`/share/auth/jwt-rotation` is the memory named `jwt-rotation` under the tree
`/share/auth`, and `~/notes/todo` resolves under your home. Returns an error
(NOT_FOUND) if no such named memory exists.

Use `me_memory_get` when you already have the UUID.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | yes | The `folder/name` path, e.g. `/share/auth/jwt-rotation`. |

## Returns

The full memory object — same shape as `me_memory_get`, including its `name`.

## Example

```json
{
  "path": "/share/auth/jwt-rotation"
}
```

## Notes

- The split is on the final `/`: a name may contain dots (`config.yaml`) but never a slash.
- Returns NOT_FOUND if no named memory matches, or the caller lacks read access.
