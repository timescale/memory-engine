---
title: Use strict-order HNSW iterative scans for filtered semantic search
status: Accepted
date: 2026-08-07
deciders: [jgpruitt]
tags: [search, semantic-search, pgvector, hnsw]
tickets: []
supersedes: []
---

# ADR 0002: Use strict-order HNSW iterative scans for filtered semantic search

## Context

Memory Engine combines semantic ranking with access-control, tree, metadata, temporal, regular-expression, and similarity filters. pgvector's HNSW index normally explores a candidate window controlled by `hnsw.ef_search`, while PostgreSQL applies additional predicates to those candidates. If filters reject many candidates, a query can return fewer than its requested limit even when more qualifying memories exist beyond the initial HNSW search horizon.

Increasing the semantic similarity threshold makes this filtered-recall gap more visible because it adds another predicate that can shrink the initial candidate set.

pgvector supports iterative HNSW scans, which continue exploring the graph when filters remove candidates. It offers `strict_order`, which preserves distance ordering, and `relaxed_order`, which can improve recall or performance at the cost of ordering guarantees. Exact rank order matters because hybrid search converts each search arm's order into Reciprocal Rank Fusion ranks.

The setting is a pgvector custom PostgreSQL parameter. Such parameters are registered lazily when pgvector loads in a database connection. A function-level `SET hnsw.iterative_scan ...` clause is validated when the function is created. During an existing-database migration, pgvector may not yet be loaded on that connection, and a non-superuser migration role can be denied permission to set the unrecognized parameter.

## Decision

Semantic search enables pgvector iterative scans in `strict_order` mode before executing its vector query:

```sql
perform set_config('hnsw.iterative_scan', 'strict_order', true);
```

The call is made inside the vector branch of the search function. Its third argument makes the setting transaction-local. It is not declared as a function-level `SET` clause.

`strict_order` is used instead of `relaxed_order` so returned semantic candidates remain ordered by cosine distance before ranks are assigned. The vector arm of hybrid search calls the same semantic search function and inherits this behavior.

`hnsw.ef_search`, `hnsw.max_scan_tuples`, and `hnsw.scan_mem_multiplier` remain at their configured defaults. With iterative scanning enabled, `ef_search` is primarily a performance tuning parameter rather than the initial candidate window becoming a correctness boundary. Further tuning requires workload-specific benchmarks.

## Consequences

- Filtered semantic searches continue scanning for qualifying candidates instead of stopping after filters shrink the initial HNSW candidate set.
- Direct semantic search and the semantic arm of hybrid search share the same recall behavior.
- Returned candidates preserve strict distance order, which keeps hybrid rank assignment deterministic for a given candidate set.
- Iterative scanning can inspect more graph tuples and increase query latency when filters are selective.
- Search remains bounded by the requested result limit and pgvector's scan limits. This improves filtered recall but does not turn approximate nearest-neighbor search into an exhaustive scan.
- Setting the parameter at query time avoids coupling function creation to whether pgvector has already registered its custom parameters on the migration connection.

## Alternatives considered

### Function-level `SET` clause

A function-level clause is concise and automatically applies on every call, but it can make an existing-database migration fail when pgvector has not loaded on the connection and the migration role is not a superuser. Query-time `set_config` applies the setting where it is needed without that creation-time dependency.

### `relaxed_order` iterative scans

Relaxed ordering can offer different performance tradeoffs, but RRF depends on the rank assigned by each search arm. Preserving strict distance order is more important than the potential performance gain.

### Increase `hnsw.ef_search` without iterative scanning

A larger fixed candidate window reduces the problem but cannot guarantee that enough rows survive arbitrary filters. It also imposes the higher search cost on queries whose filters do not need it.

### Set a database-wide default

A database-wide setting requires privileged operational configuration and applies to unrelated vector queries. Keeping the decision in the search function makes the behavior portable and scoped to Memory Engine's query.

### Derive `hnsw.ef_search` from the requested limit

This may improve latency for some workloads, but the appropriate relationship depends on data distribution and filter selectivity. It is deferred until supported by benchmarks.
