# me_memory_mv

Move memories from one tree prefix to another, preserving subtree structure.

Works like `mv` in a filesystem -- all memories under the source prefix get their prefix replaced with the destination.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `source` | `string` | yes | Source tree prefix to move from. Must be non-empty. |
| `destination` | `string` | yes | Destination tree prefix to move to. |
| `dry_run` | `boolean` | yes | If `true`, return the count without moving. If `false`, execute the move. |

## Returns

```json
{
  "count": 15
}
```

| Field | Type | Description |
|-------|------|-------------|
| `count` | `integer` | Number of memories moved (or that would be moved in dry-run mode). |

## Examples

### Rename a tree branch

```json
{
  "source": "work.old_project",
  "destination": "work.new_project",
  "dry_run": false
}
```

This moves:
- `work.old_project` -> `work.new_project`
- `work.old_project.api` -> `work.new_project.api`
- `work.old_project.api.auth` -> `work.new_project.api.auth`

### Preview a move

```json
{
  "source": "scratch",
  "destination": "archive.scratch",
  "dry_run": true
}
```

## Notes

- The subtree structure is preserved. Only the prefix is replaced.
- Useful for reorganizing knowledge, archiving old sections, or renaming tree branches.
- Preview with `dry_run: true` first to verify the scope.
