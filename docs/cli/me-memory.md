# me memory

Manage memories.

Memories are the core data type in Memory Engine. Each memory has content, optional metadata, an optional tree path for hierarchical organization, and an optional temporal range.

## Commands

- [me memory create](#me-memory-create) -- create a memory
- [me memory get](#me-memory-get) -- get a memory by ID
- [me memory search](#me-memory-search) -- search memories
- [me memory update](#me-memory-update) -- update a memory
- [me memory delete](#me-memory-delete) -- delete a memory or tree
- [me memory edit](#me-memory-edit) -- open a memory in your editor
- [me memory tree](#me-memory-tree) -- show tree structure
- [me memory move](#me-memory-move) -- move memories between tree paths
- [me memory import](#me-memory-import) -- import from files or stdin
- [me memory export](#me-memory-export) -- export with filters

---

## me memory create

Create a memory.

```
me memory create [content] [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `content` | no | Memory content. Can also be provided via `--content` or stdin. |

| Option | Description |
|--------|-------------|
| `--content <text>` | Memory content (alternative to positional argument). |
| `--tree <path>` | Tree path (e.g., `work.projects.me`). |
| `--meta <json>` | Metadata as a JSON string. |
| `--temporal <range>` | Temporal range as `start[,end]` (ISO 8601). |

Content can come from the positional argument, the `--content` flag, or piped via stdin.

---

## me memory get

Get a memory by ID. In a TTY, renders the content as ANSI-formatted markdown with dimmed YAML frontmatter. When piped or redirected, outputs raw Markdown with YAML frontmatter (suitable for `> file.md`).

```
me memory get <id> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Memory ID (UUIDv7). |

| Option | Description |
|--------|-------------|
| `--raw` | Output raw Markdown with YAML frontmatter (no ANSI), even in a TTY. |

---

## me memory search

Search memories.

```
me memory search [query] [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `query` | no | Hybrid search query (uses both semantic and fulltext search). |

| Option | Description |
|--------|-------------|
| `--semantic <text>` | Semantic (vector) search query. |
| `--fulltext <text>` | BM25 keyword search. |
| `--grep <pattern>` | Regex filter on content (POSIX, case-insensitive). |
| `--tree <filter>` | Tree path filter. Supports exact match, wildcards, negation, and label search. See [Tree filter syntax](../concepts.md#tree-filter-syntax). |
| `--meta <json>` | Metadata filter as JSON. |
| `--limit <n>` | Max results (default: 10). |
| `--candidate-limit <n>` | Pre-RRF candidate pool size. |
| `--semantic-threshold <n>` | Minimum semantic similarity score, 0-1. |
| `--temporal-contains <ts>` | Memory must contain this point in time. |
| `--temporal-overlaps <range>` | Memory must overlap this range (`start,end`). |
| `--temporal-within <range>` | Memory must be within this range (`start,end`). |
| `--weight-semantic <w>` | Semantic weight, 0-1. |
| `--weight-fulltext <w>` | Fulltext weight, 0-1. |
| `--order-by <dir>` | Sort direction: `asc` or `desc`. |

At least one search criterion is required. A positional `query` runs hybrid search by sending the same text to semantic and fulltext ranking. Use `--semantic` for pure vector search, `--fulltext` for pure keyword search, or both flags to provide different text for each mode.

### Examples

```bash
# Hybrid search (recommended default)
me memory search "how does authentication work"

# Keyword search
me memory search --fulltext "pgvector ltree"

# Hybrid with tree filter
me memory search --semantic "embedding performance" --fulltext "nomic" --tree "me.design.*"

# Browse by metadata
me memory search --meta '{"type": "decision"}' --limit 20
```

---

## me memory update

Update a memory.

```
me memory update <id> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Memory ID (UUIDv7). |

| Option | Description |
|--------|-------------|
| `--content <text>` | New content (use `-` for stdin). |
| `--tree <path>` | New tree path. |
| `--meta <json>` | New metadata as JSON (replaces existing). |
| `--temporal <range>` | New temporal range as `start[,end]`. |

At least one update option is required. Metadata is fully replaced, not merged.

---

## me memory delete

Delete a memory by ID, or all memories under a tree path.

```
me memory delete <id-or-tree> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id-or-tree` | yes | Memory ID (UUIDv7) or tree path. |

| Option | Description |
|--------|-------------|
| `--dry-run` | Preview what would be deleted (tree mode only). |
| `-y, --yes` | Skip the confirmation prompt (tree mode only). |

If the argument is a UUIDv7, deletes a single memory. If it is a tree path, deletes all memories under that path after showing a count and confirming.

---

## me memory edit

Open a memory in your editor.

```
me memory edit <id>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Memory ID (UUIDv7). |

Fetches the memory, formats it as Markdown with YAML frontmatter, and opens it in `$VISUAL`, `$EDITOR`, or `vim`. On save, the CLI parses your changes and sends an update. If there are errors, the editor re-opens.

---

## me memory tree

Show memory tree structure.

```
me memory tree [filter] [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `filter` | no | Root tree path to start from. |

| Option | Description |
|--------|-------------|
| `--levels <n>` | Max depth to display. |

Renders the tree with box-drawing characters, showing memory counts at each node.

---

## me memory move

Move memories between tree paths. Alias: `me memory mv`.

```
me memory move <src> <dst> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `src` | yes | Source tree path. |
| `dst` | yes | Destination tree path. |

| Option | Description |
|--------|-------------|
| `--dry-run` | Preview what would be moved without executing. |
| `-y, --yes` | Skip the confirmation prompt. |

Moves all memories under the source prefix to the destination, preserving subtree structure. Always shows a preview count before confirming.

---

## me memory import

Import memories from files or stdin.

```
me memory import [files...] [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `files...` | no | Files to import (use `-` for stdin). |

| Option | Description |
|--------|-------------|
| `--format <format>` | Override format detection (`md`, `yaml`, `json`). |
| `-r, --recursive` | Recursively import from directories. |
| `--fail-fast` | Stop on first error. |
| `--dry-run` | Validate without importing. |
| `-v, --verbose` | Show per-file status output. |

Supports Markdown (with YAML frontmatter), YAML, JSON, and NDJSON. Format is auto-detected from file extension or content. See [File Formats](../formats.md) for full schema documentation.

### Skipped memories

Memories with an explicit `id` that already exists in the engine are silently skipped server-side (via `ON CONFLICT DO NOTHING`) rather than failing the whole batch. The command surfaces these as `skipped` so re-imports of unchanged data and id collisions with unrelated memories are observable. Memories without an `id` get a server-generated UUIDv7 and never collide.

JSON output adds `skipped` (count) and `skippedIds` (array of conflicting ids). Text output appends `(K skipped — id already exists)` to the summary, or prints `Imported 0 memories (N already exist, no changes)` when everything was a re-import. Run with `--verbose` to see each skipped id inline.

Skipped memories do not contribute to the exit code; only parse and engine errors do.

`--dry-run` validates parsing only; it does not predict id collisions with already-imported memories. Run with `--verbose` after a real import to see the skipped ids.

### Chunking and partial failures

Large imports are sliced into multiple `batchCreate` requests under the hood to fit under the server's request-body limit. Each chunk is sent sequentially. If a chunk fails (network error, server error), siblings are not affected -- the successful chunks still land. The failed chunk's items are reported as `failed`, and the chunk-level error message appears in the `errors` array (sourced as `chunk N (K items)`).

This means partial failures are now possible: `imported > 0` and `failed > 0` can both be true in the same run. Re-running the import with the same input will pick up where the previous run left off (already-inserted ids are skipped via `ON CONFLICT DO NOTHING`, missing ids are inserted).

---

## me memory export

Export memories with filters.

```
me memory export [file] [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `file` | no | Output file or directory (stdout if omitted). |

| Option | Description |
|--------|-------------|
| `--tree <filter>` | Tree path filter. |
| `--format <fmt>` | Output format: `json`, `yaml`, `md` (default: `json`). |
| `--meta <json>` | Metadata filter as JSON. |
| `--limit <n>` | Max memories to export (default: 1000). |
| `--temporal-contains <ts>` | Memory must contain this point in time. |
| `--temporal-overlaps <range>` | Memory must overlap this range. |
| `--temporal-within <range>` | Memory must be within this range. |

For `md` format with a directory output, each memory is written as an individual `.md` file with YAML frontmatter. Exported content is compatible with `me memory import`. See [File Formats](../formats.md) for full schema documentation.
