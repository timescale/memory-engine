# File Formats

Import and export use the same memory structure across all formats. This page is the canonical reference for the JSON, YAML, Markdown, and NDJSON schemas used by both the CLI (`me memory import` / `me memory export`) and MCP tools (`me_memory_import` / `me_memory_export`).

## Memory fields

Every memory has one required field (`content`) and four optional fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | no | UUIDv7. Enables idempotent imports -- re-importing the same ID won't create a duplicate. Must match `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`. |
| `content` | `string` | **yes** | The memory text. Must be non-empty. |
| `meta` | `object` | no | Arbitrary key-value metadata. Any valid JSON object. |
| `tree` | `string` | no | Hierarchical path using dot-separated labels (e.g. `work.projects.api`). Labels must be alphanumeric or underscore. Must match `^([A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*)?$`. |
| `temporal` | varies | no | Time range for the memory. Accepted shapes depend on format -- see below. |

### Temporal input shapes

The `temporal` field normalizes to `{start: string, end?: string}` where timestamps are ISO 8601 with timezone offset (e.g. `2024-01-15T10:30:00Z`).

Different formats accept different input shapes:

| Input shape | JSON | YAML | Markdown |
|-------------|------|------|----------|
| String -- interpreted as start | yes | yes | yes |
| Array of 1-2 strings -- `[start]` or `[start, end]` | yes | yes | yes |
| Object -- `{start, end?}` | yes | yes | yes |

Examples:

```json
"temporal": "2024-01-15T00:00:00Z"
"temporal": ["2024-01-01T00:00:00Z", "2024-12-31T23:59:59Z"]
"temporal": {"start": "2024-01-01T00:00:00Z", "end": "2024-12-31T23:59:59Z"}
```

YAML and Markdown exports use the object form, so exported files can be re-imported without conversion.

---

## JSON

A JSON array of memory objects. This is the default export format.

```json
[
  {
    "id": "0194a000-0001-7000-8000-000000000001",
    "content": "Project started with three engineers",
    "tree": "work.projects.api",
    "meta": { "source": "import", "author": "jane" },
    "temporal": { "start": "2024-01-15T00:00:00Z" }
  },
  {
    "content": "Switched to PostgreSQL for the queue",
    "tree": "work.projects.api",
    "meta": { "type": "decision" }
  }
]
```

A single object (not wrapped in an array) is also accepted:

```json
{
  "content": "Single memory import",
  "tree": "notes"
}
```

**File extensions**: `.json`

---

## NDJSON

Newline-delimited JSON -- one JSON object per line. Useful for streaming or large datasets.

```
{"content": "First memory", "tree": "notes"}
{"content": "Second memory", "tree": "notes", "meta": {"priority": "high"}}
{"content": "Third memory", "tree": "notes"}
```

NDJSON is auto-detected when the content contains multiple lines that each start with `{`. It is parsed using the JSON parser internally.

**File extensions**: `.ndjson`, `.jsonl`

> NDJSON is supported for import only. Export always produces a JSON array.

---

## YAML

A YAML array of memory objects.

```yaml
- id: "0194a000-0001-7000-8000-000000000001"
  content: Project started with three engineers
  tree: work.projects.api
  meta:
    source: import
    author: jane
  temporal:
    start: "2024-01-15T00:00:00Z"
    end: "2024-12-31T23:59:59Z"

- content: Switched to PostgreSQL for the queue
  tree: work.projects.api
  meta:
    type: decision
```

A single object (not wrapped in an array) is also accepted:

```yaml
content: Single memory import
tree: notes
```

**File extensions**: `.yaml`, `.yml`

---

## Markdown

A Markdown file with optional YAML frontmatter. The frontmatter carries the metadata fields; the body after the closing `---` is the memory content.

```markdown
---
id: 0194a000-0001-7000-8000-000000000001
tree: work.projects.api
meta:
  source: import
  type: decision
temporal:
  start: "2024-01-01T00:00:00Z"
  end: "2024-06-30T23:59:59Z"
---

We decided to use PostgreSQL as the task queue backend instead of Redis.
The main reasons were transactional guarantees and operational simplicity.
```

A file with no frontmatter is treated as a single memory with the entire file as content:

```markdown
This entire file becomes the memory content.
No metadata, tree, or temporal information.
```

**One memory per file.** Each `.md` file produces exactly one memory. To import multiple memories, use a directory with `--recursive` (CLI) or use JSON/YAML format instead.

**File extensions**: `.md`, `.markdown`

### Markdown export

When exporting to Markdown, each memory is written as an individual `{id}.md` file in a directory. Frontmatter includes `created_at` (CLI only) in addition to the standard fields. The `created_at` field is informational and is ignored on re-import.

- **CLI**: requires a directory path when exporting multiple memories. Single-memory export to stdout is allowed.
- **MCP**: when `path` is provided, creates or uses it as a directory of `.md` files. When `path` is null (inline), only single-memory export is allowed -- multiple memories will return an error asking for a directory path.

---

## Format detection

When no explicit format is specified, the format is detected automatically.

### By file extension

| Extension | Format |
|-----------|--------|
| `.json` | JSON |
| `.ndjson` | NDJSON (parsed as JSON) |
| `.jsonl` | NDJSON (parsed as JSON) |
| `.yaml` | YAML |
| `.yml` | YAML |
| `.md` | Markdown |
| `.markdown` | Markdown |

### By content sniffing (stdin)

When reading from stdin or a content string with no file extension, the format is detected from the content:

| Content starts with | Detected format |
|---------------------|-----------------|
| `---` | Markdown |
| `{` or `[` | JSON |
| Anything else | YAML |

An explicit `--format` (CLI) or `format` parameter (MCP) always takes precedence over auto-detection.

---

## Limits

| Limit | Value | Applies to |
|-------|-------|------------|
| Batch size | 1,000 memories | Per import request |
| Request body | 1 MB | API request size (import via `content` / MCP inline) |

When importing from a file path, the file is read server-side and the 1 MB request limit does not apply. Use `path` instead of `content` for large imports.

---

## Round-trip compatibility

Exported files can be re-imported directly. The export output uses the same field names and structure as the import schema.

The `id` field is preserved in exports, so re-importing an export is idempotent -- existing memories with the same ID are not duplicated.

Fields that appear in exports but are not part of the import schema (like `created_at` in Markdown frontmatter) are silently ignored on re-import.
