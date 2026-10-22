# me_memory_export

Bulk export memories with filters. Writes to a file or returns content inline.

Prefer `path` to write directly to a file instead of returning content through the conversation.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `space` | `string` | varies | Absent in locked mode; required nonempty string in multi-space mode. It selects the same-server space for this call. |
| `tree` | `string \| null` | no | Tree path filter. Omit or pass `null` for all memories. |
| `meta` | `object \| null` | no | Metadata filter. Omit or pass `null` to skip. |
| `metaPredicate` | `string \| null` | no | PostgreSQL JSONPath Boolean predicate evaluated against metadata with `@@`. Omit or pass `null` to skip. |
| `temporal` | `object \| null` | no | Temporal filter. Omit or pass `null` to skip. |
| `format` | `string` | yes | Output format: `"json"`, `"yaml"`, or `"md"`. |
| `limit` | `integer \| null` | no | Maximum memories to export. Omit or pass `null` for default (200), maximum 200. |
| `path` | `string \| null` | no | File or directory path inside the MCP server's working directory (relative paths resolve from there; paths that leave it, or that name a dotfile or dot-directory, are refused). For `md` format, use a directory path to write one `.md` file per memory. Omit or pass `null` to return content inline. |
| `overwrite` | `boolean \| null` | no | Replace files that already exist at `path`. Default `false`: an existing file is left alone and the call fails. |

### temporal

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `before` | `string \| null` | no | Find memories strictly before this point in time. |
| `after` | `string \| null` | no | Find memories strictly after this point in time. |
| `contains` | `string \| null` | no | Find memories containing this point in time. |
| `overlaps` | `object \| null` | no | Find memories overlapping this range (`{start, end}`). |
| `within` | `object \| null` | no | Find memories fully within this range (`{start, end}`). |

You can provide multiple temporal fields; all populated predicates must match.

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
| `path` | `string` | The absolute file path that was written to (JSON/YAML). |
| `directory` | `string` | The absolute directory that `.md` files were written to (Markdown). |

### When `path` is omitted (inline output)

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
  "tree": "/share/design/*",
  "format": "yaml",
  "path": "memories/design-export.yaml"
}
```

### Export as Markdown directory

```json
{
  "tree": "/share/design/*",
  "format": "md",
  "path": "memories/design-export"
}
```

The directory mirrors the tree: each memory is written to `<tree-as-directories>/<name-or-id>.md` with YAML frontmatter (including `name` when set). A named memory uses its name as the filename; an unnamed one falls back to `{id}.md`. The directory is created if it does not exist.

### Export inline for inspection

```json
{
  "meta": { "type": "decision" },
  "format": "json",
  "limit": 10
}
```

## Notes

- **Prefer `path` for large exports** to avoid returning large payloads through the conversation. Omit `path` only for small result sets or when you need to inspect the content.
- **Files stay in the working directory.** `path` is resolved against the directory the MCP server was started in and must not leave it (symlinks are followed before the check); dotfiles and dot-directories are never written. Existing files are only replaced when `overwrite` is `true`.
- The exported content is directly compatible with [me_memory_import](me_memory_import.md). Exported files and directories can be re-imported directly.
- **Markdown format**: use a directory path for multi-memory export. The directory mirrors the tree -- each memory is written to `<tree-as-directories>/<name-or-id>.md`. Inline Markdown export (omitting `path`) is only supported for single-memory results.
- Results are sorted in ascending order by creation time.
- The `tree` filter supports exact match, wildcards, negation, and label search. See [Tree filter syntax](../concepts.md#tree-filter-syntax) for the full reference. Use `/share/!archived/*{0,}` to export everything under `/share` except archived content.
- See [File Formats](../formats.md) for full schema documentation and format details.
