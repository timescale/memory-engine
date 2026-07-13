# me_memory_copy

Copy memories from one tree prefix to another, preserving subtree structure.

The source memories are preserved. Copied memories receive new IDs.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `source` | `string` | yes | Source tree prefix to copy from. Must be non-empty. |
| `destination` | `string` | yes | Destination tree prefix to copy to. Must be non-empty. |
| `dry_run` | `boolean` | yes | If `true`, return the count without copying. If `false`, execute the copy. |

## Returns

```json
{
  "count": 42
}
```

| Field | Type | Description |
|-------|------|-------------|
| `count` | `integer` | Number of memories copied, or that would be copied in dry-run mode. |

## Examples

### Preview copy

```json
{
  "source": "/share/projects/old",
  "destination": "/share/projects/archive",
  "dry_run": true
}
```

### Execute copy

```json
{
  "source": "/share/projects/old",
  "destination": "/share/projects/archive",
  "dry_run": false
}
```

## Notes

- This copies memories at the exact source path and all descendants.
- The source memories are not removed.
- Repeating a real copy creates additional copies with new IDs.
- Requires read access on the source and write access on the destination.
