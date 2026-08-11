# Design

This directory describes Memory Engine's implemented design. These are living
documents: update them in place when the design changes. Focus on the model,
interfaces, invariants, constraints, and operational tradeoffs that future work
must preserve.

## Harnesses

| Document | Scope |
| --- | --- |
| [Harness integrations](harness-integrations.md) | Shared policy, lifecycle, runtime contract, and security boundaries |
| [Claude Code adapter](harnesses/claude.md) | Plugin, environment injection, MCP, and capture |
| [OpenCode adapter](harnesses/opencode.md) | MCP entry, plugin, environment injection, and capture |
| [Codex CLI adapter](harnesses/codex.md) | MCP entry, hooks, command rewrite, and capture |

## Database

| Document | Scope |
| --- | --- |
| [Database migrations and versioning](database-migrations-and-versioning.md) | Schema evolution, deployment reconciliation, and SQL function safety |

## Embeddings

| Document | Scope |
| --- | --- |
| [Embedding queue and worker](embedding-queue-and-worker.md) | Asynchronous vector generation and backlog processing |

## Spaces

| Document | Scope |
| --- | --- |
| [Spaces and provisioning](spaces.md) | Space isolation, lifecycle, and custom defaults |

## Authorization

| Document | Scope |
| --- | --- |
| [Principal model](principal-model.md) | Users, groups, service accounts, and agent removal |
| [Memory authorization](memory-authorization.md) | Space admission, tree grants, and effective access |
| [Restricted API keys](restricted-api-keys.md) | Scoped personal and service-account credentials |

## Presentation

| Document | Scope |
| --- | --- |
| [Field projection and format selection](field-projection-and-format-selection.md) | CLI and MCP memory-read presentation |

## Search

| Document | Scope |
| --- | --- |
| [Semantic search scoring](semantic-search-scoring.md) | Cosine similarity scores and thresholds |
| [Filtered semantic search](hnsw-filtered-semantic-search.md) | HNSW recall and rank ordering under filters |
| [Fulltext BM25 scoring](fulltext-bm25-scoring.md) | Positive lexical-match invariant and score semantics |
| [Hybrid RRF scoring](hybrid-rrf-scoring.md) | Fusion behavior, candidate windows, and tuning |
| [Metadata predicates](jsonpath-metadata-predicates.md) | Advanced JSONPath metadata filtering |
