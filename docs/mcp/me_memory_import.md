# me_memory_import

Bulk import memories from a file, directory, or content string.

Parses the input according to the specified format and creates all memories in one batch. Directories are imported recursively. Prefer `path` over `content` to avoid passing large payloads through the conversation.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string \| null` | yes | Absolute path to a file or directory. Directories are imported recursively. Format is inferred from extension (`.json`, `.yaml`, `.yml`, `.md`, `.ndjson`, `.jsonl`). Mutually exclusive with `content`. |
| `content` | `string \| null` | yes | Raw content to import (JSON array, YAML array, or Markdown with frontmatter). Mutually exclusive with `path`. |
| `format` | `string \| null` | yes | Content format: `"json"`, `"yaml"`, or `"md"`. Required when using `content`. Optional when using `path` (inferred from file extension). |

One of `path` or `content` must be provided.

### Supported formats

JSON (array or single object), NDJSON, YAML (array or single object), and Markdown (YAML frontmatter + body, one memory per file).

Each memory object supports fields: `id`, `content` (required), `meta`, `tree`, `temporal`.

See [File Formats](../formats.md) for full schema documentation, examples, and format detection rules.

## Returns

```json
{
  "imported": 2,
  "ids": [
    "0194a000-0001-7000-8000-000000000001",
    "0194a000-0002-7000-8000-000000000002"
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `imported` | `number` | Number of memories successfully imported. |
| `ids` | `string[]` | UUIDs of the created memories. |

## Examples

### Import from file (preferred)

```json
{
  "path": "/Users/me/memories/export.yaml",
  "content": null,
  "format": null
}
```

Format is inferred from the `.yaml` extension.

### Import from directory

```json
{
  "path": "/Users/me/memories/export-dir",
  "content": null,
  "format": null
}
```

Recursively imports all supported files (`.json`, `.yaml`, `.yml`, `.md`, `.ndjson`, `.jsonl`).

### Import from content string

```json
{
  "path": null,
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
