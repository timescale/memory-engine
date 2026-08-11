---
title: Memory Schema
tags: [memory, schema, modeling, temporal, metadata, trees]
---

# Memory Schema

Each space has one `memory` table. The table is a flexible substrate for context
engineering, not a prescribed ontology for facts, conversations, or skills. A
memory is content plus three independent annotations: a hierarchical tree, free
form metadata, and an optional temporal range. Callers choose the conventions
that fit their workflow; Memory Engine does not extract facts, infer entities,
or transform content into a hidden schema.

This shape supports several common memory types without separate tables:

| Type | Typical representation |
| --- | --- |
| Working memory | Kept by the caller in the active context window; retrieved memories may be added when relevant. |
| Episodic memory | Immutable or append-oriented content with a point-in-time temporal value. |
| Semantic memory | A discrete fact, preference, decision, or reference, optionally with a validity range. |
| Procedural memory | A runbook, workflow, or reusable instruction stored as content and organized by tree and metadata. |

The storage model does not reserve one representation for any of these types.
`meta` conventions can distinguish them when an application needs to filter or
operate on a category.

## Record fields

| Field | Meaning |
| --- | --- |
| `id` | Immutable UUIDv7 identity. It supports chronological ordering and survives a move or rename. |
| `content` | Required, caller-provided text. It is the source for full-text and semantic search. |
| `tree` | Required `ltree` path that organizes the memory and defines its authorization boundary. |
| `meta` | Required JSON object, defaulting to `{}`. It holds caller-defined facets and source information. |
| `temporal` | Optional `tstzrange` describing when the memory happened or was valid. |
| `name` | Optional mutable filename-like leaf name, unique within one exact tree. |
| `embedding` | Optional vector derived asynchronously from `content`. |
| `created_at`, `updated_at` | Storage timestamps, distinct from the represented time in `temporal`. |
| `version`, `version_hash` | Server-maintained optimistic-concurrency state. |

`id` is the canonical address. A named memory also has a human-friendly
`tree/name` address, such as `/share/auth/jwt-rotation`. The name is not part of
the `ltree`, so dots in a filename do not create a hierarchy. Multiple unnamed
memories may share a tree; a non-null name is unique only within that exact tree.

## Orthogonal annotations

### Tree

The tree is a hierarchy, not just an organizational tag. It supports subtree
search and is the unit of data access: a grant covers its path and descendants.
Conventional roots are `/share` for collaboration and each user's private home
tree. See [Memory Authorization](memory-authorization.md) for access semantics.

### Metadata

`meta` is an object rather than a fixed column set. It can hold type, source,
importer, status, owner-defined facets, or any other workflow-specific data.
JSONB supports exact metadata filters and JSONPath predicates without forcing
all users into a global schema. Metadata is stored as supplied; callers own the
meaning and lifecycle of their keys.

### Temporal range

`temporal` models the time represented by the memory, not its database creation
time. A point event uses equal inclusive bounds, such as a message, commit, or
deployment. A period uses an inclusive start and exclusive end, such as the
validity of a fact, a project phase, or an outage. The database enforces these
two conventions. A temporal range can be queried by containment and overlap,
making time both a modeling and retrieval dimension.

## Search substrate

The model exposes six composable retrieval dimensions. A caller selects the
dimensions that match the question instead of passing every request through a
fixed extraction or retrieval pipeline.

| Dimension | Record field or index | Use |
| --- | --- | --- |
| Semantic | HNSW over `embedding` | Find related meaning when the wording differs. |
| Full-text | BM25 over `content` | Match exact identifiers, terms, and phrases. |
| Hierarchy | GiST over `tree` | Scope retrieval to a path or subtree. |
| Temporal | GiST over `temporal` | Find information that contains, overlaps, precedes, or follows a time window. |
| Metadata | GIN over `meta` | Filter caller-defined facets with structured metadata or JSONPath. |
| Regex | Case-insensitive POSIX expression over `content` | Apply an exact content pattern alongside an indexed query or filter. |

Regex is deliberately required to accompany semantic or full-text search, a
tree, structured metadata, or a temporal filter. Used alone, it could force an
unbounded scan; it is a precision filter, not a broad retrieval primitive.

Hybrid is not a seventh independent dimension. It is an optional ranking mode
that combines semantic and full-text result sets through Reciprocal Rank Fusion
(RRF). The public product description calls this one of six *search modes*:
semantic, keyword, temporal, metadata, hierarchy, and hybrid. That
mode-oriented wording emphasizes how people initiate a search; the API-oriented
model retains regex as the sixth composable dimension and treats hybrid as the
ranking composition of two dimensions.

For example, an agent can use semantic search plus a project tree to explore a
concept, BM25 plus a temporal range to investigate a change, regex plus metadata
to find a precise format within a source corpus, or hybrid ranking followed by
any of those filters. The schema makes all of these query-time choices possible.

## Writes, identity, and concurrency

Creating a memory requires an explicit target tree. The idempotency key depends
on the record shape:

- A named memory is keyed by `(tree, name)`; name takes precedence over a
  supplied `id` for deduplication.
- An unnamed memory with an explicit `id` is keyed by that id.
- An unnamed memory without an `id` is anonymous and always inserts.

`onConflict: error` rejects a collision, `replace` updates only when the stored
content, metadata, or temporal value differs, and `ignore` leaves the existing
record unchanged. A named replacement keeps the existing record identity. This
makes importer reruns predictable while preserving links to a named record.

Updates use the current `version_hash`. Any change to tree, name, metadata,
temporal value, or content increments `version` and computes a new hash. A patch
with an old hash fails rather than silently overwriting a concurrent edit.

## Embedding lifecycle

Embeddings are derived data, not the memory's source of truth. A content change
clears the current embedding and increments the content version so the embedding
worker can regenerate it. Metadata, tree, name, and temporal changes do not
require re-embedding because they do not change the text being represented. A
memory remains usable for all non-semantic retrieval while embedding is pending.

## Consequences

- The database contains the content the caller wrote, with explicit annotations;
  there is no hidden fact-extraction or summarization layer.
- A record can be moved, renamed, or reclassified without changing its immutable
  id.
- Created and updated timestamps answer when storage changed; `temporal` answers
  when the represented information occurred or applied.
- New use cases should normally begin with tree and metadata conventions, not a
  new memory table or a new fixed record type.
