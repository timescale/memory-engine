# me_memory_append

Append text to an existing memory's content in one atomic operation.

Unlike `me_memory_update`, append does not fetch and rewrite the whole body: the server concatenates the new text server-side in a single statement, so the full content is never round-tripped and **metadata is never touched**. The `version_hash` is recomputed in-database and a new embedding is scheduled automatically.

Append is safe to retry. Each call carries an operation-scoped `idempotency_key`; if a request is retried (or races another with the same key), the server replays the original result instead of appending twice. A different request sent with a key that was already used is a `CONFLICT`.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string \| null` | one of id/path | The UUID of the memory to append to. |
| `path` | `string \| null` | one of id/path | Address the memory by its `tree/name` path (e.g. `share/notes/log`) instead of `id`. Provide exactly one of `id` or `path`. |
| `content` | `string` | yes | Text to append to the memory's content. |
| `separator` | `string \| null` | no | String inserted between the existing content and the appended text. Defaults to two newlines (`"\n\n"`). Omitted when the existing content is empty or already ends with the separator; existing content is never trimmed. |
| `version_hash` | `string \| null` | no | Optional optimistic-concurrency guard (32-char md5 hex). When supplied it must match the memory's current `version_hash`, or the append is rejected with `CONFLICT` and nothing is written. When omitted, the append is unconditional. |
| `idempotency_key` | `string \| null` | no | Operation-scoped key so a retried append is applied at most once. A random key is generated per call when omitted. Reusing a key for a **different** append (different target, separator, or content) fails with `CONFLICT`. |

## Returns

A compact result — **never the memory body**:

```json
{
  "id": "0194a000-0001-7000-8000-000000000001",
  "version": 3,
  "versionHash": "9b7e4c5e8a1f3d2c6b0a4f7e8d1c2b3a",
  "appendedBytes": 42,
  "contentLength": 512,
  "replayed": false
}
```

- `version` / `versionHash` — the memory's new version after the append (use the hash for a subsequent optimistic update).
- `appendedBytes` — UTF-8 size of the separator + appended text.
- `contentLength` — character length of the content after the append.
- `replayed` — `true` when this call matched a prior `idempotency_key` and replayed the earlier result instead of appending again.

## Example

Append a line to a running log, letting a fresh key be generated:

```json
{
  "path": "share/status/deploy-log",
  "content": "2025-04-15 14:02 — deploy 20260710.3 healthy"
}
```

Append with an explicit key so a retry is safe, and a custom separator:

```json
{
  "id": "0194a000-0001-7000-8000-000000000001",
  "content": "- follow-up item",
  "separator": "\n",
  "idempotency_key": "0194a111-2222-7000-8000-000000000abc"
}
```

## When to append vs. update

- Adding to a growing log, transcript, or checklist → **append**.
- Correcting or restructuring existing content, or changing `tree`/`name`/`meta` → **update**.
- New distinct information → **create** a new memory.

## Notes

- **Metadata is never modified by append.** To change `meta`, use `me_memory_update` (which fully replaces `meta`).
- `version` advances by 1 and `versionHash` is recomputed on every append; a new embedding is scheduled automatically (`hasEmbedding` may briefly become `false`).
- Append is the one memory mutation the client retries on transient transport failures — the `idempotency_key` makes that safe. Ordinary mutations (`create`/`update`/`delete`) are not retried.
- Returns a `NOT_FOUND` error if the memory does not exist, and `FORBIDDEN` if you lack write access to its tree.
