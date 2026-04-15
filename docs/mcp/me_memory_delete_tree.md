# me_memory_delete_tree

Delete all memories under a tree prefix.

Use `dry_run: true` to preview how many memories would be deleted without actually removing them.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `tree` | `string` | yes | Tree prefix -- all memories at or below this path will be deleted. Must be non-empty. |
| `dry_run` | `boolean` | yes | If `true`, return the count without deleting. If `false`, execute the deletion. |

## Returns

```json
{
  "count": 42
}
```

| Field | Type | Description |
|-------|------|-------------|
| `count` | `integer` | Number of memories deleted (or that would be deleted in dry-run mode). |

## Examples

### Preview deletion

```json
{
  "tree": "pack.datasync",
  "dry_run": true
}
```

### Execute deletion

```json
{
  "tree": "pack.datasync",
  "dry_run": false
}
```

## Notes

- This deletes memories at the exact path **and** all descendants. `tree: "work"` deletes `work`, `work.projects`, `work.projects.me`, etc.
- Always preview with `dry_run: true` first to avoid surprises.
- This operation is irreversible.
