# me_memory_tree

View the hierarchical tree structure of memories with counts at each node.

Shows how memories are organized and how many exist at each level. Use this to understand the overall shape of stored knowledge before searching.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `tree` | `string \| null` | yes | Root path to display from (e.g., `work.projects`). Pass `null` for the full tree. |
| `levels` | `integer` | yes | Maximum depth to display. Pass `0` for unlimited. |

## Returns

```json
{
  "nodes": [
    { "path": "me", "count": 45 },
    { "path": "me.design", "count": 30 },
    { "path": "me.design.auth", "count": 8 },
    { "path": "me.strategy", "count": 15 },
    { "path": "pack", "count": 120 }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `nodes` | `array` | Array of tree nodes. |
| `nodes[].path` | `string` | The tree path for this node. |
| `nodes[].count` | `integer` | Number of memories at or below this path. |

## Examples

### Full tree overview

```json
{
  "tree": null,
  "levels": 2
}
```

### Explore a specific branch

```json
{
  "tree": "me.design",
  "levels": 0
}
```

## Notes

- This is a read-only operation. Use it to orient yourself before searching or browsing.
- The `count` for a node includes all memories at that exact path and all descendants.
- Use `levels` to control how deep the tree is displayed. `levels: 1` shows only immediate children.
