# Searching Memories

Memory Engine search has three ranked modes — **semantic**, **fulltext**, and **hybrid** — plus a set of **filters** you can combine with any of them (or use on their own to browse). This page explains how the modes differ, what the `score` means in each, and how to tune a query to return only good matches — or as many good matches as possible.

See also: [Core Concepts → Search](concepts.md#search), the CLI [`me memory search`](cli/me-memory.md), and the MCP [`me_memory_search`](mcp/me_memory_search.md) tool.

## Search modes

| Mode | What it matches | How to invoke |
| --- | --- | --- |
| **Semantic** | Meaning / concepts, via vector embeddings and cosine similarity. Finds related ideas even when the words differ. | `--semantic <text>` (CLI); `semantic` (MCP/API) |
| **Fulltext** | Exact keywords, identifiers, error strings — BM25 relevance over stemmed terms. | `--fulltext <text>` (CLI); `fulltext` (MCP/API) |
| **Hybrid** | Both at once, combined with Reciprocal Rank Fusion (RRF). | pass **both** `--semantic` and `--fulltext`, or a positional `me memory search "query"` |
| **Filter-only** | No ranking — just browse memories matching your filters. | any filter (`--tree`, `--meta`, `--temporal-*`, `--grep`) with no `--semantic`/`--fulltext` |

Choose deliberately: **semantic** for "things about X," **fulltext** for a specific term, filename, or error, and **hybrid** when both kinds of matching help the same query.

Fulltext tokenization lowercases, drops common English stop words, and stems (`running` matches `run`). A query made entirely of stop words has no terms to match and returns nothing.

## What `score` means

Every result carries a `score`, but its meaning **depends on the mode**. Scores are comparable **within a single result set**, not across modes or across queries.

| Mode | `score` |
| --- | --- |
| Semantic | Cosine similarity in `[-1, 1]` — higher is more similar (`1` = identical direction, `0` = unrelated). |
| Fulltext | A positive, **unnormalized** BM25 relevance score (`> 0`, unbounded — it can exceed `1`). Only genuine term matches are returned; non-matches are never included. |
| Hybrid | The fused RRF score — a small positive number that reflects how highly, and how consistently, a memory ranked across the two modes. It measures **rank agreement, not absolute relevance**. |
| Filter-only | An unranked sentinel (`-1`); results are ordered by recency instead. |

Because a fulltext score is unnormalized and depends on your corpus and the query terms, and a hybrid score depends on rank position within the candidate pool, there is **no fixed "good score" number** for those modes — the only meaningful absolute bar is on the semantic side (below).

## Filters

Filters narrow any search (and can be used alone to browse):

- `--tree <filter>` — restrict to a subtree or pattern. See [Tree filter syntax](concepts.md#tree-filter-syntax).
- `--meta <json>` — require metadata attributes (e.g. `{"type":"decision"}`).
- `--temporal-before` / `--temporal-after` — require the memory's range to be strictly before or after a point in time.
- `--temporal-contains` / `--temporal-overlaps` / `--temporal-within` — filter by containment or range relationships.
- `--grep <pattern>` — regex over content. It must accompany another criterion (it can't be the only filter).

## Thresholds and tuning

- **`--semantic-threshold <n>` (`semanticThreshold`)** — minimum cosine similarity, in `[0, 1]`. Higher is stricter (`0.8` ≈ strong matches; `0.5` ≈ loosely related). Values outside `[0, 1]` are rejected, not clamped. Applies only to the semantic/vector match.
- **`--weight-semantic` / `--weight-fulltext` (`weights`)** — in hybrid mode, bias the fusion toward one mode or the other (each `0`–`1`).
- **`--candidate-limit <n>` (`candidateLimit`)** — how many candidates each mode contributes to hybrid fusion before ranking. Larger widens the pool at some cost.
- **`--limit <n>` (`limit`)** — maximum results to return. Range `1`–`1000` (see the cap below).

There is intentionally **no fulltext or RRF score threshold**. A BM25 score has no corpus- and query-independent meaning, and an RRF score measures rank agreement rather than relevance — so neither offers a value you could set by intuition. Instead, fulltext already returns *only* genuine term matches, and you can bound quality on the semantic side with `--semantic-threshold`.

## Retrieving as many good matches as possible

If you want "all the good matches," not just the top handful, raise `--limit` and lean on a **single-mode** search with a quality bar:

- **Semantic:** `--semantic "…" --semantic-threshold 0.7 --limit 1000`. Search automatically keeps scanning the vector index when filters or the threshold prune matches, so a high limit returns everything above your similarity bar (up to the cap), not just an initial window.
- **Fulltext:** `--fulltext "…" --limit 1000`. Only genuine term matches are ever returned, so a high limit gets them all (up to the cap).

**Hybrid returns a fused top-k, not an exhaustive set** — it's the wrong tool for "give me everything above a bar." For that, prefer a single-mode search with a threshold as above.

### The result cap

A single search returns at most **1000** results. This is a safety bound, not a relevance judgment: thresholds and filters trim *within* the results a query retrieves — they don't turn search into an exhaustive scan of the whole space. Truly exhaustive retrieval (fetch *every* match, paginated) is not part of search today; for now, tighten your filters/threshold and tree scope to bring the set under the cap.

## Ordering

- **Ranked** searches (semantic, fulltext, hybrid) are always ordered by `score`, best first.
- **Filter-only** searches are ordered by recency — newest first by default, or oldest first with `--order-by asc`.
