# me memory

Manage memories.

Memories are the core data type in Memory Engine. Each memory has content, an optional tree path for hierarchical organization, an optional filename-like `name` (unique within the tree), optional metadata, and an optional temporal range.

## Commands

- [me memory create](#me-memory-create) -- create a memory
- [me memory get](#me-memory-get) -- get a memory by ID or path
- [me memory search](#me-memory-search) -- search memories
- [me memory update](#me-memory-update) -- update a memory
- [me memory delete](#me-memory-delete) -- delete a single memory
- [me memory deltree](#me-memory-deltree) -- delete a subtree
- [me memory edit](#me-memory-edit) -- open a memory in your editor
- [me memory count](#me-memory-count) -- count memories matching a tree filter
- [me memory tree](#me-memory-tree) -- show tree structure
- [me memory copy](#me-memory-copy) -- copy memories between tree paths
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
| `--tree <path>` | **Required.** Tree path where the memory is stored (e.g., `/share/work/projects`). Use `/share` for memories the rest of the space should see, or `~` (your private home, e.g. `~/notes`) for memories that must stay private to you. |
| `--name <slug>` | Optional filename-like leaf name, unique within the tree (e.g. `jwt-rotation`). Lets you later address the memory by path (`/share/auth/jwt-rotation`) and re-create idempotently. |
| `--meta <json>` | Metadata as a JSON string. |
| `--temporal <range>` | Temporal range as `start[,end]` (ISO 8601). |
| `--replace` | On a conflict (a `--name` already taken in that tree), replace the existing memory in place when content/meta/temporal differ -- a no-op when identical. |
| `--ignore` | On a conflict, skip silently and leave the existing memory untouched. |

Content can come from the positional argument, the `--content` flag, or piped via stdin. A `--tree` path is required. Without `--replace`/`--ignore`, creating a second memory with a `--name` already used in that tree errors with `CONFLICT`.

---

## me memory get

Get a memory by ID or by its `tree/name` path. In a TTY, renders the content as ANSI-formatted markdown with dimmed YAML frontmatter. When piped or redirected, outputs raw Markdown with YAML frontmatter (suitable for `> file.md`).

```
me memory get <id-or-path> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id-or-path` | yes | A memory ID (UUIDv7), or a named memory's `tree/name` path (e.g. `/share/auth/jwt-rotation`, `~/notes/todo`). A UUID is fetched by id; anything else is resolved by path (split at the final `/`). |

| Option | Description |
|--------|-------------|
| `--raw` | Output raw Markdown with YAML frontmatter (no ANSI), even in a TTY. |

```bash
me memory get 0194a000-0001-7000-8000-000000000001   # by id
me memory get /share/auth/jwt-rotation                # by path
```

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
me memory search --semantic "embedding performance" --fulltext "nomic" --tree "/me/design/*"

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
| `--name <slug>` | Set or rename the memory's name. Pass an empty string (`--name ""`) to clear it. |
| `--meta <json>` | New metadata as JSON (replaces existing). |
| `--temporal <range>` | New temporal range as `start[,end]`. |

At least one update option is required. Metadata is fully replaced, not merged. Update is id-addressed; you can pass a `tree/name` path as the `<id>` argument and the CLI resolves it to an id first.

---

## me memory delete

Delete a **single** memory, by ID or by its `tree/name` path. To delete a whole subtree, use [`me memory deltree`](#me-memory-deltree).

```
me memory delete <id-or-path>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id-or-path` | yes | A memory ID (UUIDv7), or a memory's `tree/name` path (e.g. `/share/auth/jwt-rotation`). |

A UUIDv7 deletes that one memory by id; anything else is a `tree/name` path (split at the final `/`) that deletes at most that one named memory. It never deletes a subtree — a path that names no existing memory reports "not found" rather than removing everything beneath it.

Alias: `me memory rm`.

---

## me memory deltree

Delete **every** memory at or under a tree path (a subtree).

```
me memory deltree <tree> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `tree` | yes | A tree path; all memories at or under it are deleted (e.g. `/share/old-project`). |

| Option | Description |
|--------|-------------|
| `--dry-run` | Preview the count without deleting anything. |
| `-y, --yes` | Skip the confirmation prompt. |

Always previews the count first, so `--dry-run` can never delete. Without `--yes`, an interactive run shows the count and asks to confirm before deleting.

Alias: `me memory rmtree`.

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

## me memory count

Count memories matching a tree filter. Alias: `me count`.

```
me memory count <tree> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `tree` | yes | Tree filter: path prefix, `lquery` pattern, or `ltxtquery` label search. |

| Option | Description |
|--------|-------------|
| `--max-count <n>` | Stop counting after this many matches. If the returned count reaches this value, text output says `at least N memories`. |

Examples:

```bash
me memory count share.projects
me memory count 'share.projects.*' --max-count 100
me memory count 'api & v2'
```

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

## me memory copy

Copy memories between tree paths. Alias: `me memory cp`.

```
me memory copy <src> <dst> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `src` | yes | Source tree path. |
| `dst` | yes | Destination tree path. |

| Option | Description |
|--------|-------------|
| `--dry-run` | Preview what would be copied without executing. |
| `-y, --yes` | Skip the confirmation prompt. |

Copies all memories under the source prefix to the destination, preserving subtree structure. The source memories are preserved and copied memories receive new IDs. Repeating a real copy creates additional copies. Always shows a preview count before confirming.

Examples:

```bash
me memory copy share.old share.archive --dry-run
me memory copy share.old share.archive --yes
```

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

Import memories from files or stdin. This is an alias of [`me import memories`](me-import.md#me-import-memories) (unlike the other memory subcommands, `import` has no bare top-level alias — the top-level `me import` is the [import group](me-import.md)).

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

Import submits with `onConflict: 'ignore'`, so a record whose idempotency key already exists -- its explicit `id`, or its `(tree, name)` slot -- is silently skipped rather than failing the whole batch. The command surfaces these as `skipped` so re-imports of unchanged data and id collisions with unrelated memories are observable. Records without an `id` and without a `name` get a server-generated UUIDv7 and never collide.

JSON output adds `skipped` (count) and `skippedIds` (array of conflicting ids). Text output appends `(K skipped — already exist)` to the summary, or prints `Imported 0 memories (N already exist, no changes)` when everything was a re-import. Run with `--verbose` to see each skipped id inline. (Skip tracking is by explicit `id` only; a named, id-less record skipped on its `(tree, name)` slot isn't reflected in the `skipped` count.)

Skipped memories do not contribute to the exit code; only parse and server errors do.

`--dry-run` validates parsing only; it does not predict id collisions with already-imported memories. Run with `--verbose` after a real import to see the skipped ids.

### Chunking and partial failures

Large imports are sliced into multiple `batchCreate` requests under the hood to fit under the server's request-body limit. Each chunk is sent sequentially. If a chunk fails (network error, server error), siblings are not affected -- the successful chunks still land. The failed chunk's items are reported as `failed`, and the chunk-level error message appears in the `errors` array (sourced as `chunk N (K items)`).

This means partial failures are now possible: `imported > 0` and `failed > 0` can both be true in the same run. Re-running the import with the same input will pick up where the previous run left off (already-present rows are skipped via `onConflict: 'ignore'`, missing ones are inserted).

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

For `md` format with a directory output, the directory mirrors the tree: each memory is written to `<dir>/<tree-as-directories>/<name-or-id>.md`. A named memory uses its name as the filename; an unnamed one falls back to `{id}.md`. Frontmatter includes `name` when set. Exported content is compatible with `me memory import`. See [File Formats](../formats.md) for full schema documentation.
