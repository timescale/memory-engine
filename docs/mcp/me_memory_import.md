# me_memory_import

Bulk import memories from a file, directory, or content string.

Parses the input according to the specified format and creates all memories in one batch. Directories are imported recursively. Prefer `path` over `content` to avoid passing large payloads through the conversation.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `space` | `string` | varies | Absent in locked mode; required nonempty string in multi-space mode. It selects the same-server space for this call. |
| `path` | `string \| null` | no | File or directory path. Directories are imported recursively. Format is inferred from extension (`.json`, `.yaml`, `.yml`, `.md`, `.ndjson`, `.jsonl`). When both inputs are provided, `path` takes precedence. |
| `content` | `string \| null` | no | Raw content to import (JSON array, YAML array, or Markdown with frontmatter). Used when `path` is omitted. |
| `format` | `string \| null` | no | Content format: `"json"`, `"yaml"`, or `"md"`. Optional; content is detected when omitted. |

At least one of `path` or `content` must be provided.

### Supported formats

JSON (array or single object), NDJSON, YAML (array or single object), and Markdown (YAML frontmatter + body, one memory per file).

Each memory object supports fields: `id`, `content` (required), `name`, `meta`, `tree`, `temporal`. Unlike `me_memory_create` (which requires an explicit `tree`), a record with no `tree` is imported into the shared root `share`.

Import submits with `onConflict: 'ignore'`, so a record whose idempotency key already exists is skipped rather than erroring. A named record uses its `(tree, name)` slot in preference to its `id`. Re-importing the same data is a no-op.

See [File Formats](../formats.md) for full schema documentation, examples, and format detection rules.

## Returns

```json
{
  "imported": 2,
  "skipped": 1,
  "failed": 0,
  "ids": [
    "0194a000-0001-7000-8000-000000000001",
    "0194a000-0002-7000-8000-000000000002"
  ],
  "skippedIds": [
    "0194a000-0003-7000-8000-000000000003"
  ],
  "errors": []
}
```

| Field | Type | Description |
|-------|------|-------------|
| `imported` | `number` | Number of memories successfully imported on this call. |
| `skipped` | `number` | Number of memories whose idempotency key already existed in the space. Always present (may be `0`). |
| `failed` | `number` | Number of memories in chunks that errored before reaching the server. Always present (may be `0`). |
| `ids` | `string[]` | UUIDs of the memories actually inserted on this call. |
| `skippedIds` | `string[]` | Stored IDs of skipped memories. Always present (may be empty). Inspect any of these with `me_memory_get` to see what's there. |
| `errors` | `Array<{ chunkIndex, itemCount, ids, error }>` | One entry per failed chunk. Always present (may be empty). |

The tool is idempotent: re-calling with the same arguments leaves the space in the same state. A record with neither an `id` nor a `name` gets a server-generated UUIDv7 and never collides; a named record is keyed on its `(tree, name)` slot.

### Chunking and partial failures

Large imports are sliced into multiple `batchCreate` requests under the hood to fit under the server's request-body limit. Chunks are sent sequentially. If a chunk fails, siblings are not affected -- the successful chunks still land. The failed chunk's items are reported under `failed`/`errors`, and re-calling with the same arguments will pick up where the previous call left off.

The tool throws only when **every** chunk fails (total failure). For mixed outcomes it returns the partial-success detail above so the caller can decide how to react.

## Examples

### Import from file (preferred)

```json
{
  "path": "/Users/me/memories/export.yaml"
}
```

Format is inferred from the `.yaml` extension.

### Import from directory

```json
{
  "path": "/Users/me/memories/export-dir"
}
```

Recursively imports all supported files (`.json`, `.yaml`, `.yml`, `.md`, `.ndjson`, `.jsonl`).

### Import from content string

```json
{
  "content": "[{\"content\": \"Hello world\", \"tree\": \"test\"}]",
  "format": "json"
}
```

## Notes

- **Prefer `path` over `content`** for token efficiency. Reading from a file avoids passing the entire payload through the conversation.
- If `id` is provided in a memory object, it enables idempotent imports -- re-importing the same data won't create duplicates.
- This is the counterpart to [me_memory_export](me_memory_export.md). Exported files can be re-imported directly.
- Returns an error if `path` is provided but the file or directory does not exist.
- When `path` is a directory, all supported files are imported recursively. Format is inferred per file from extension.
