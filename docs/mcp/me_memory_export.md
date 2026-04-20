# me_memory_export

Bulk export memories with filters. Writes to a file or returns content inline.

Prefer `path` to write directly to a file instead of returning content through the conversation.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `tree` | `string \| null` | yes | Tree path filter. Pass `null` for all memories. |
| `meta` | `object \| null` | yes | Metadata filter. Pass `null` to skip. |
| `temporal` | `object \| null` | yes | Temporal filter. Pass `null` to skip. |
| `format` | `string` | yes | Output format: `"json"`, `"yaml"`, or `"md"`. |
| `limit` | `integer` | yes | Maximum memories to export. Pass `0` for default (1000). |
| `path` | `string \| null` | yes | Absolute file or directory path. For `md` format, use a directory path to write one `.md` file per memory. Pass `null` to return content inline. |

### temporal

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `contains` | `string \| null` | yes | Find memories containing this point in time. |
| `overlaps` | `object \| null` | yes | Find memories overlapping this range (`{start, end}`). |
| `within` | `object \| null` | yes | Find memories fully within this range (`{start, end}`). |

## Returns

### When `path` is provided (file output)

```json
{
  "count": 42,
  "path": "/Users/me/memories/export.yaml"
}
```

For `md` format with a directory path:

```json
{
  "count": 42,
  "directory": "/Users/me/memories/export-dir"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `count` | `number` | Number of memories exported. |
| `path` | `string` | The file path that was written to (JSON/YAML). |
| `directory` | `string` | The directory that `.md` files were written to (Markdown). |

### When `path` is null (inline output)

```json
{
  "count": 3,
  "content": "[{\"id\": \"...\", \"content\": \"...\", ...}, ...]"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `count` | `number` | Number of memories exported. |
| `content` | `string` | The formatted content string in the requested format. |

## Examples

### Export to file (preferred)

```json
{
  "tree": "me.design.*",
  "meta": null,
  "temporal": null,
  "format": "yaml",
  "limit": 0,
  "path": "/Users/me/memories/design-export.yaml"
}
```

### Export as Markdown directory

```json
{
  "tree": "me.design.*",
  "meta": null,
  "temporal": null,
  "format": "md",
  "limit": 0,
  "path": "/Users/me/memories/design-export"
}
```

Each memory is written as `{id}.md` with YAML frontmatter. The directory is created if it does not exist.

### Export inline for inspection

```json
{
  "tree": null,
  "meta": { "type": "decision" },
  "temporal": null,
  "format": "json",
  "limit": 10,
  "path": null
}
```

## Notes

- **Prefer `path` for large exports** to avoid returning large payloads through the conversation. Use inline (`path: null`) only for small result sets or when you need to inspect the content.
- The exported content is directly compatible with [me_memory_import](me_memory_import.md). Exported files and directories can be re-imported directly.
- **Markdown format**: use a directory path for multi-memory export. Each memory is written as `{id}.md`. Inline Markdown export (`path: null`) is only supported for single-memory results.
- Results are sorted in ascending order by creation time.
- The `tree` filter supports exact match, wildcards, negation, and label search. See [Tree filter syntax](../concepts.md#tree-filter-syntax) for the full reference. Use `me.!archived.*{0,}` to export everything under `me` except archived content.
- See [File Formats](../formats.md) for full schema documentation and format details.
