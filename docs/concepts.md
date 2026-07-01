# Core Concepts

## Memories

A memory is a single piece of knowledge. Every memory has:

- **content** (required) -- the text of the memory. Be specific and self-contained.
- **tree** -- a hierarchical path for organizing and browsing (e.g., `/share/auth` or `/work/projects/api`).
- **name** (optional) -- a human-chosen, filename-like slug, unique within its tree (e.g., `jwt-rotation`). Lets you address the memory as a path like `/share/auth/jwt-rotation` instead of by UUID, and serves as the upsert key for re-runs. Mutable. Matches `^[A-Za-z0-9][A-Za-z0-9._-]*$`, ≤128 chars -- dots are allowed, slashes are not. Distinct from, and in addition to, the memory's immutable UUID.
- **meta** -- key-value metadata for filtering (e.g., `{"type": "decision", "confidence": "high"}`).
- **temporal** -- a time association, either a point-in-time or a date range.

Every memory also has an immutable **id** (a UUIDv7) -- the stable identity that survives renames and moves. The server mints it; callers may supply one only to preserve identity across import/export.

Each space stores its memories in a single PostgreSQL table (the `me_<slug>` schema). There are no separate tables for different "types" of memory -- the type is a convention in `meta`, not a schema distinction. This keeps queries simple and the data model flexible.

### Best practices

- **One idea per memory.** Three decisions = three memories.
- **Be specific.** "Auth uses bcrypt with cost 12" not "we use bcrypt."
- **Search before creating** to avoid duplicates.
- **Use all dimensions.** Tree for hierarchy, meta for attributes, temporal for time.
- **Start with the key fact.** Put the decision or insight first, then add context after. Structure for scannability.

### Content patterns

- **Decision pattern** -- state the decision, then the rationale. "We chose OpenAI text-embedding-3-small because..."
- **Preference pattern** -- state the preference and the scope. "For SQL, use lowercase keywords and leading-comma table definitions."
- **Context pattern** -- describe the situation and its implications. "The embedding worker polls every 10s with adaptive delay."

### Anti-patterns

- **Too granular** -- don't store every line of code or every config value. Store insights and decisions.
- **Too broad** -- "we use PostgreSQL" is too generic to be useful. Add specifics.
- **Stale without temporal** -- if content has a shelf life, set temporal so it can be filtered by time.
- **Duplicating docs** -- store insights about docs, not copies of docs.

### Memory lifecycle

- **When to create**: decisions, context, patterns/conventions, solved problems, preferences.
- **When to update**: core fact changed, adding context to an existing idea, reorganizing, archiving.
- **When to create new** (not update): the information is distinct, even if related to an existing memory.
- **Maintenance**: periodically review memories for accuracy. Use `meta: {"confidence": "low"}` for uncertain content. Track sources with `meta: {"source": "..."}` for traceability.

## Tree Paths

Tree paths organize memories into a browsable hierarchy of labels:

```
/work
/work/projects
/work/projects/api
/work/projects/api/auth
/personal/reading
/personal/reading/books
```

Tree paths use PostgreSQL's `ltree` extension under the hood. Each label matches `[A-Za-z0-9_-]` (letters, digits, underscores, and hyphens). The **canonical form uses `/` with a leading slash**: the root is `/`, an absolute path is `/share/auth`, and your home is `~/notes`. This is what the API and CLI display, and what you should write (the leading slash is optional when you type a path).

> The tree-filter patterns below use lquery / ltxtquery operators (`*`, `{}`, `|`, `!`, `&`) layered on top of these paths.

Keep paths **2-4 levels deep**. Deeper nesting rarely helps findability.

### Reserved roots

Every space has two conventional roots:

- **`/share`** -- the shared root. Memories the rest of the space should see go here (`/share/work/projects`, etc.). The file importers default a tree-less record to `share`.
- **`/home/<member_id>`** -- your private per-member root. The input shortcut **`~`** expands to your own home, so `~/notes` resolves to `/home/<your-id>/notes` and displays back as `~/notes`. An **agent**'s home nests under its owner's (`/home/<owner-id>/<agent-id>`), so the agent's `~` is visible to its owner.

`me memory create` (and the `me_memory_create` MCP tool) **require** an explicit tree -- choose `share` for shared memories or `~` for private ones. See [Access Control](access-control.md) for how grants attach to these paths.

### Tree filter syntax

When filtering by tree (in search, export, or browse), the system auto-detects which syntax you're using:

**Exact match** -- a plain path. Matches that node and all descendants.

| Pattern | Matches |
|---------|---------|
| `/work/projects` | `/work/projects`, `/work/projects/api`, `/work/projects/api/auth`, etc. |

**Pattern matching (lquery)** -- triggered when the pattern contains `*`, `!`, `{`, `}`, `|`, `@`, or `%`. Uses wildcards and quantifiers.

| Pattern | Meaning |
|---------|---------|
| `/work/projects/*` | All descendants of `/work/projects` (any depth) |
| `/work/*{1}` | Direct children of `/work` only (exactly 1 level) |
| `/work/*{2,4}` | Descendants 2-4 levels below `/work` |
| `/work/*{0,}` | `/work` itself plus all descendants (equivalent to `/work`) |
| `*/api/*` | Any path containing the label `api` at any position |
| `*/!draft/*` | Any path that does NOT contain the label `draft` |
| `/work\|personal/*` | Paths starting with `work` or `personal`, then anything |
| `/me/!archived/*{0,}` | Everything under `/me` except the `/me/archived` subtree |

**Label search (ltxtquery)** -- triggered when the pattern contains `&`. Boolean search over path labels.

| Pattern | Meaning |
|---------|---------|
| `api & auth` | Paths containing both `api` and `auth` labels |
| `api | auth` | Paths containing either label |
| `api & !draft` | Paths with `api` but not `draft` |

### Conventions

Below the two reserved roots, tree paths are user-defined. There is no mandated hierarchy. Common patterns:

```
/share/work/projects/<name>   # shared per-project knowledge
/share/design/<subsystem>     # shared design decisions
/pack/<pack-name>             # installed memory packs (their own root)
~/notes/<topic>               # private notes
```

## Addressing & Conflicts

A memory can be addressed two ways:

- **By id** -- the immutable UUID (`memory.get`, `memory.delete`; `me get <uuid>`). Stable across renames and moves.
- **By path** -- a named memory's `tree/name`, split at the final `/` (`memory.getByPath`, `memory.deleteByPath`; `me get /share/auth/jwt-rotation`). The last segment is the name; the rest is the tree. A name may contain dots (`config.yaml`) but never a slash.

The CLI's `me get` / `me delete` auto-detect: a UUID is treated as an id, anything else as a `tree/name` path -- and `me delete` only ever removes that single memory. `me update` is id-addressed (it resolves a path to an id first). Deleting a whole subtree is `me deltree <path>` / `memory.deleteTree`.

### Conflict handling

Create and batch-create take an `onConflict` policy, applied against the memory's **idempotency key** -- a named memory's `(tree, name)` slot (the name takes precedence over any explicit id), or the explicit id for an unnamed one:

- **`error`** (default) -- a clash raises `CONFLICT`.
- **`replace`** -- overwrite in place, but only when something actually differs (content, meta, or temporal); an identical re-submit is a no-op. The id is preserved, and the embedding is recomputed only when content changes.
- **`ignore`** -- skip the conflicting row, leaving the existing one untouched.

`onConflict` governs a clash on that idempotency key only. A *named* memory whose explicit id happens to collide with a **different** existing row still raises a primary-key violation regardless of `ignore`/`replace` -- so `ignore` means "ignore an idempotency-key conflict", not "ignore any conflict". (Importers mint random ids, so this doesn't arise in practice.)

This makes re-runs idempotent. The transcript and git importers submit with `replace` and stamp `meta.importer_version`, so an unchanged re-import does nothing while a parser-version bump re-renders. The file importers (`me import memories`, the `me_memory_import` tool, `me pack install`) submit with `ignore`, so re-importing or re-installing is a no-op. (There is no separate "upsert" flag -- content-aware `replace` covers it.)

## Metadata

Metadata is a JSON object attached to each memory. Use it for structured attributes that you want to filter on:

```json
{
  "type": "decision",
  "source": "slack",
  "confidence": "high",
  "reviewed": true
}
```

Metadata is indexed with a GIN index, making attribute-based filtering fast. You can filter by any key-value pair in search queries.

### Common meta keys

| Key | Purpose | Example values |
|-----|---------|----------------|
| `type` | Classify the memory | `"decision"`, `"reference"`, `"guide"`, `"note"` |
| `status` | Track lifecycle | `"active"`, `"implemented"`, `"superseded"`, `"archived"` |
| `source` | Where it came from | `"slack"`, `"meeting"`, `"docs"`, `"code-review"` |
| `confidence` | How certain you are | `"high"`, `"medium"`, `"low"` |
| `display_name` | Human label for the web tree | `"Weekly Sync — 2026-06-23"` |

`display_name` is a presentation hint: the web UI's tree view prefers it over the memory's `name` and content when labelling a leaf. Use it when the stable `name` is an opaque id (e.g. an importer keying idempotency on a source id) but you still want a readable label. It does not affect addressing or search.

### Reserved thread-link keys

Some memories form an ordered **thread** -- the messages of one agent session, or a run of git commits. Three reserved `$`-prefixed meta keys stitch them together, and the web UI renders **Previous** / **Next** / **Entire thread** buttons from them:

| Key | Purpose | Value |
|-----|---------|-------|
| `$prev` | The previous memory in the thread. | A memory path (e.g. `/share/projects/foo/agent_sessions/s1/msg_2`) |
| `$next` | The next memory in the thread. Optional. | A memory path |
| `$thread` | A grouping id shared by every memory in the thread. | An opaque string (the importers use the session id) |

The values of `$prev`/`$next` are memory paths (the same form `memory.getByPath` accepts), so they stay stable across re-imports (unlike a memory's id). `$thread` is just a grouping key: a search with `meta: {"$thread": "<id>"}` returns the whole thread.

`$next` is optional and usually left unset -- it can be derived by finding the memory whose `$prev` points back at the current one (`meta: {"$prev": "<this memory's path>"}`), which is what the web UI does when no explicit `$next` is present. By convention `$prev` is (almost) always set; the head of a thread has none.

The conversation importers (`me import claude` / `codex` / `opencode`) set `$prev` + `$thread`; the git importer (`me import git`) sets `$prev` only. You can set these keys on your own memories to build custom threads.

### Meta vs. tree

- **Tree** gives one hierarchical path per memory and supports subtree queries. Use for browsable organization.
- **Meta** allows multiple flat attributes and faceted filtering. Use for searchable classification.
- **Use both.** They serve different purposes and work well together.

**Important:** metadata is fully replaced on update, not merged. If you want to add a key, fetch the current metadata first, merge locally, then send the full object.

## Temporal Ranges

Memories can have an associated time range:

- **Point-in-time** -- a single timestamp (e.g., "this decision was made on 2025-04-15").
- **Date range** -- a start and end (e.g., "this was true from January to March 2025").

Temporal ranges use PostgreSQL's `tstzrange` type and support three query modes:

- **contains** -- find memories whose range contains a specific point in time.
- **overlaps** -- find memories whose range overlaps a given range.
- **within** -- find memories whose range falls entirely within a given range.

Temporal is optional. Not all memories need a time association.

## Embeddings

When a memory is created or updated, a vector embedding is computed asynchronously in the background. Embeddings enable semantic search -- finding memories by meaning rather than exact keywords.

The `hasEmbedding` field on a memory indicates whether the embedding has been computed yet. New memories will briefly have `hasEmbedding: false` until the background worker processes them (typically 10-30 seconds).

**Practical implication:** fulltext search works immediately after creation. Semantic search requires the embedding -- if you need to find a memory right away, use fulltext or filters.

If embedding fails (e.g., provider API error), the worker retries up to 3 times. After 3 failures, the memory remains without an embedding but is still fully functional for non-semantic search.

## Search

Memory Engine supports three search modes. Quick guide:

- **Know the exact words?** Use fulltext.
- **Know the concept but not the wording?** Use semantic.
- **Want comprehensive results?** Use hybrid (both).
- **Browsing a category?** Use filters only (tree, meta, temporal).

### Semantic search

Find memories by meaning. Uses vector embeddings and cosine similarity.

```bash
me memory search --semantic "how does authentication work"
```

Good for finding conceptually related content even when the exact words differ. For short literal terms, identifiers, and exact words, prefer fulltext or hybrid search; semantic-only rankings are not lexical and can return unrelated short memories.

### Fulltext search

Find memories by keywords. Uses PostgreSQL BM25 ranking.

```bash
me memory search --fulltext "pgvector ltree BM25"
```

Good for finding memories with specific terms, names, or identifiers.

### Hybrid search

Combine both modes. Results are ranked using Reciprocal Rank Fusion (RRF), which merges the two ranked lists into a single result set.

```bash
me memory search "embedding performance"
# or provide different text for each ranker:
me memory search --semantic "embedding performance" --fulltext "nomic ollama"
```

Good when you want both meaning-based and keyword-based relevance. The positional CLI query uses hybrid search and is the recommended default.

### Filters

All search modes can be combined with filters:

- **tree** -- restrict to a branch of the tree hierarchy.
- **meta** -- filter by metadata attributes.
- **temporal** -- filter by time range.
- **grep** -- regex pattern filter on content.

Filters can also be used alone (without semantic or fulltext) to browse memories.

### Scoring

Search results include a `score` between 0 and 1, where 1 is the best match. For hybrid search, scores are computed via RRF fusion. For filter-only queries, results are sorted by creation time (configurable with `order_by`).

## Spaces

A **space** is an isolated collection of memories with its own roster, groups, and access grants. Each space has:

- Its own memories (the `me_<slug>` table) and tree hierarchy.
- A roster of **principals** -- users, agents, and groups.
- Tree-access grants that control who can read/write/own which paths.

A space is identified by an immutable 12-character **slug** (also the `X-Me-Space` header value) and a renamable display **name**. A user can belong to many spaces; each memory lives in exactly one space. There are no organization, engine, or shard concepts above a space.

Manage spaces with [`me space`](cli/me-space.md), and see [Access Control](access-control.md) for principals and grants.
