# me_memory_revert

Restore a memory to an earlier version's state, applied as a new forward version.

Reverting does not rewrite history — it reproduces the version-N snapshot as the memory's current state, which bumps the version and records a new `revert` event. Look up the target version with [me_memory_history](me_memory_history.md).

Reverting a **deleted** memory re-creates it (undelete), continuing its version sequence so version numbers stay monotonic for that id. The full snapshot is restored (`content`, `meta`, `tree`, `name`, `temporal`), so a revert can move the memory back to an old tree or hit a `(tree, name)` conflict if that slot is now occupied. Only versions still within the audit retention window (30 days) can be reverted.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `space` | `string` | varies | Absent in locked mode; required nonempty string in multi-space mode. It selects the same-server space for this call. |
| `id` | `string \| null` | no | The UUID of the memory to revert. Provide `id` or `path`. |
| `path` | `string \| null` | no | `tree/name` path of the memory; resolves live, else via the audit log (so a deleted memory can be undeleted by path). |
| `version` | `number` | yes | The version number to restore. |
| `expectedVersionHash` | `string \| null` | no | Only revert if the memory's current `versionHash` matches — guards against a concurrent change to a live memory. Omit for a deliberate override. |

Provide `id` or `path` (at least one is required). If both are given, `path` takes precedence.

## Returns

The reverted memory, in the same shape as [me_memory_get](me_memory_get.md) — with a bumped `version` and a new `versionHash`.

## Example

Restore a memory to version 2:

```json
{
  "id": "0194a000-0001-7000-8000-000000000001",
  "version": 2
}
```

Undelete a memory to its last version, by path:

```json
{
  "path": "/share/auth/jwt-rotation",
  "version": 5
}
```

## Notes

- Requires write access on the memory's current tree and, when the target version lived elsewhere, on that tree too.
- Reverting to the memory's current state is a no-op (no new version).
- A version outside the retention window, or one you cannot read, returns an error.
- `NOT_FOUND` if neither `id` nor `path` resolves; `CONFLICT` if restoring the snapshot's `(tree, name)` collides with an existing memory.
