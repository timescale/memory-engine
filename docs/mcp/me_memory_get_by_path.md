# me_memory_get_by_path

Retrieve a single named memory by its `tree/name` path.

The last path segment is the name; the rest is the tree. For example,
`/share/auth/jwt-rotation` is the memory named `jwt-rotation` under the tree
`/share/auth`, and `~/notes/todo` resolves under your home. Returns an error
(NOT_FOUND) if no such named memory exists.

Use `me_memory_get` when you already have the UUID.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `space` | `string` | varies | Absent in locked mode; required nonempty string in multi-space mode. It selects the same-server space for this call. |
| `path` | `string` | yes | The `tree/name` path, e.g. `/share/auth/jwt-rotation`. |
| `select` | `string[] \| null` | no | Fields to present. Omit or pass `null` for the complete memory. Supports response fields, `meta.keyName`, and content slices. |
| `format` | `"yaml" \| "json" \| "compact" \| null` | no | Text serialization format. Omit or pass `null` for YAML; `json` and `compact` both return compact JSON. |

## Returns

The tool returns YAML by default. The JSON shape is the same as
`me_memory_get`, including its `name`; pass `format: "json"` or
`format: "compact"` for compact JSON text.

## Example

```json
{
  "path": "/share/auth/jwt-rotation"
}
```

## Notes

- The split is on the final `/`: a name may contain dots (`config.yaml`) but never a slash.
- Returns NOT_FOUND if no named memory matches, or the caller lacks read access.
- Omit `select` or pass `null` to receive the complete memory object. An empty selection or multiple distinct content slices are invalid. The complete suffix after `meta.` is the metadata key. Content slices use UTF-16 code-unit offsets and include the full UTF-16 `contentLength`.
