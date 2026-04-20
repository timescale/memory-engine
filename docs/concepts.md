# Core Concepts

## Memories

A memory is a single piece of knowledge. Every memory has:

- **content** (required) -- the text of the memory. Be specific and self-contained.
- **tree** -- a hierarchical dot-path for organizing and browsing (e.g., `work.projects.api`).
- **meta** -- key-value metadata for filtering (e.g., `{"type": "decision", "confidence": "high"}`).
- **temporal** -- a time association, either a point-in-time or a date range.

Memories are stored in a single PostgreSQL table. There are no separate tables for different "types" of memory -- the type is a convention in `meta`, not a schema distinction. This keeps queries simple and the data model flexible.

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

Tree paths organize memories into a browsable hierarchy using dot-separated labels:

```
work
work.projects
work.projects.api
work.projects.api.auth
personal.reading
personal.reading.books
```

Tree paths use PostgreSQL's `ltree` extension. Labels must be **lowercase alphanumeric with underscores** (no spaces, hyphens, or uppercase).

Keep paths **2-4 levels deep**. Deeper nesting rarely helps findability. When unsure about the right tree path, omit it -- you can always add one later, and content is still findable via search.

### Tree filter syntax

When filtering by tree (in search, export, or browse), the system auto-detects which syntax you're using:

**Exact match (ltree)** -- plain dot-separated path. Matches that node and all descendants.

| Pattern | Matches |
|---------|---------|
| `work.projects` | `work.projects`, `work.projects.api`, `work.projects.api.auth`, etc. |

**Pattern matching (lquery)** -- triggered when the pattern contains `*`, `!`, `{`, `}`, `|`, `@`, or `%`. Uses wildcards and quantifiers.

| Pattern | Meaning |
|---------|---------|
| `work.projects.*` | All descendants of `work.projects` (any depth) |
| `work.*{1}` | Direct children of `work` only (exactly 1 level) |
| `work.*{2,4}` | Descendants 2-4 levels below `work` |
| `work.*{0,}` | `work` itself plus all descendants (equivalent to ltree `work`) |
| `*.api.*` | Any path containing the label `api` at any position |
| `*.!draft.*` | Any path that does NOT contain the label `draft` |
| `work|personal.*` | Paths starting with `work` or `personal`, then anything |
| `me.!archived.*{0,}` | Everything under `me` except the `me.archived` subtree |

**Label search (ltxtquery)** -- triggered when the pattern contains `&`. Boolean search over path labels.

| Pattern | Meaning |
|---------|---------|
| `api & auth` | Paths containing both `api` and `auth` labels |
| `api | auth` | Paths containing either label |
| `api & !draft` | Paths with `api` but not `draft` |

### Conventions

Tree paths are user-defined. There is no mandated hierarchy. Common patterns:

```
work.projects.<name>        # per-project knowledge
me.design.<subsystem>       # design decisions
pack.<pack-name>            # installed memory packs
notes.<topic>               # general notes
```

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
me memory search "how does authentication work"
```

Good for finding conceptually related content even when the exact words differ.

### Fulltext search

Find memories by keywords. Uses PostgreSQL BM25 ranking.

```bash
me memory search --fulltext "pgvector ltree BM25"
```

Good for finding memories with specific terms, names, or identifiers.

### Hybrid search

Combine both modes. Results are ranked using Reciprocal Rank Fusion (RRF), which merges the two ranked lists into a single result set.

```bash
me memory search --semantic "embedding performance" --fulltext "nomic ollama"
```

Good when you want both meaning-based and keyword-based relevance.

### Filters

All search modes can be combined with filters:

- **tree** -- restrict to a branch of the tree hierarchy.
- **meta** -- filter by metadata attributes.
- **temporal** -- filter by time range.
- **grep** -- regex pattern filter on content.

Filters can also be used alone (without semantic or fulltext) to browse memories.

### Scoring

Search results include a `score` between 0 and 1, where 1 is the best match. For hybrid search, scores are computed via RRF fusion. For filter-only queries, results are sorted by creation time (configurable with `order_by`).

## Engines

An engine is an isolated memory database. Each engine has its own:

- Memories
- Users, roles, and grants
- API keys
- Tree hierarchy

Engines belong to organizations. A user can have access to multiple engines across multiple organizations, but each memory lives in exactly one engine.
