# me_memory_import

Bulk import memories from a file or content string.

Parses the input according to the specified format and creates all memories in one batch. Prefer `path` over `content` to avoid passing large payloads through the conversation.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string \| null` | yes | Absolute file path to import from. Format is inferred from extension (`.json`, `.yaml`, `.yml`, `.md`). Mutually exclusive with `content`. |
| `content` | `string \| null` | yes | Raw content to import (JSON array, YAML array, or Markdown with frontmatter). Mutually exclusive with `path`. |
| `format` | `string \| null` | yes | Content format: `"json"`, `"yaml"`, or `"md"`. Required when using `content`. Optional when using `path` (inferred from file extension). |

One of `path` or `content` must be provided.

### Format specifications

**JSON** -- a JSON array of memory objects:

```json
[
  {
    "content": "First memory",
    "tree": "notes",
    "meta": { "source": "import" }
  },
  {
    "content": "Second memory",
    "tree": "notes"
  }
]
```

**YAML** -- a YAML array of memory objects:

```yaml
- content: First memory
  tree: notes
  meta:
    source: import
- content: Second memory
  tree: notes
```

**Markdown** -- memories separated by frontmatter blocks:

```markdown
---
tree: notes
meta:
  source: import
---

First memory

---
tree: notes
---

Second memory
```

Each memory object supports: `id`, `content`, `meta`, `tree`, `temporal`.

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
- Returns an error if `path` is provided but the file does not exist.
