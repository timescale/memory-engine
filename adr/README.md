# Architecture Decision Records

This directory records significant architectural decisions for Memory Engine. An ADR explains the context that led to a decision, the decision itself, and its consequences. ADRs are historical records: when a decision changes, add a new ADR that supersedes the old one instead of rewriting the old decision.

ADRs use numbered filenames and a lightweight Nygaard format:

- **Context** describes the problem and constraints.
- **Decision** states the chosen approach.
- **Consequences** records benefits, costs, and limitations.
- **Alternatives considered** explains why other approaches were not chosen.

The `status` field progresses from `Proposed` to `Accepted`, `Deprecated`, or `Superseded`. The `supersedes` field contains ADR numbers when a decision replaces earlier records. The `tickets` field contains only publicly accessible issue references.

## Decisions

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-semantic-search-scoring.md) | Use cosine similarity for semantic search scores | Accepted |
| [0002](0002-hnsw-filtered-recall.md) | Use strict-order HNSW iterative scans for filtered semantic search | Accepted |
| [0003](0003-fulltext-bm25-scoring.md) | Return only positive BM25 matches from fulltext search | Accepted |
| [0004](0004-hybrid-rrf-scoring.md) | Use Reciprocal Rank Fusion without a fused-score threshold | Accepted |
| [0005](0005-jsonpath-metadata-predicates.md) | Expose PostgreSQL JSONPath predicates for advanced metadata filtering | Accepted |
