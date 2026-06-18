# me_memory_count

Count memories matching a tree filter.

The `tree` input is required and supports a path prefix (`ltree`), an `lquery` pattern, or an `ltxtquery` label search.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `tree` | `string` | yes | Tree filter: path prefix (for example, `work.projects`), `lquery` pattern (for example, `*.api.*`), or `ltxtquery` label search (for example, `api & v2`). |
| `max_count` | `integer \| null` | no | Stop counting after this many matches. If the returned `count` equals `max_count`, treat the result as "at least `max_count`" rather than an exact total. |

## Returns

```json
{
  "count": 42
}
```

| Field | Type | Description |
|-------|------|-------------|
| `count` | `integer` | Number of matching memories, capped at `max_count` when provided. |

## Examples

### Count a subtree

```json
{
  "tree": "share.projects"
}
```

### Check whether many memories match

```json
{
  "tree": "share.projects.*",
  "max_count": 100
}
```

### Count by labels

```json
{
  "tree": "api & v2"
}
```

## Notes

- This is a read-only operation.
- A bare path counts memories at that path and descendants.
- If `max_count` is provided and `count == max_count`, the real total may be exactly `max_count` or greater.
