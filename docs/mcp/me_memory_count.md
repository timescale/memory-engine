# me_memory_count

Count memories matching a tree filter.

The `tree` input is required and supports an exact path prefix, a wildcard pattern, or a label search. See [Tree filter syntax](../concepts.md#tree-filter-syntax) for the full reference.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `tree` | `string` | yes | Tree filter: an exact path prefix (for example, `/share/projects`), a wildcard pattern (for example, `*/api/*`), or a label search (for example, `api & v2`). |
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
  "tree": "/share/projects"
}
```

### Check whether many memories match

```json
{
  "tree": "/share/projects/*",
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
