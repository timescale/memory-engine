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
| `path` | `string \| null` | yes | Absolute file path to write to. If provided, content is written to the file and not returned inline. Pass `null` to return content inline. |

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

| Field | Type | Description |
|-------|------|-------------|
| `count` | `number` | Number of memories exported. |
| `path` | `string` | The file path that was written to. |

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
- The exported content is directly compatible with [me_memory_import](me_memory_import.md). Exported files can be re-imported directly.
- Results are sorted in ascending order by creation time.
- The `tree` filter uses the same syntax as `me_memory_search` -- use `work.*` for descendants, bare `work` for exact match.
- See [File Formats](../formats.md) for full schema documentation and format details.
