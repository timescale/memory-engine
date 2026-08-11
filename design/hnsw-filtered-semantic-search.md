---
title: Filtered Semantic Search
tags: [search, semantic-search, pgvector, hnsw]
---

# Filtered Semantic Search

## HNSW behavior under filters

Memory Engine combines semantic ranking with access-control, tree, metadata, temporal, regular-expression, and similarity filters. pgvector's HNSW index normally explores a candidate window controlled by `hnsw.ef_search`, while PostgreSQL applies additional predicates to those candidates. If filters reject many candidates, a query can return fewer than its requested limit even when more qualifying memories exist beyond the initial HNSW search horizon.

Increasing the semantic similarity threshold makes this filtered-recall gap more visible because it adds another predicate that can shrink the initial candidate set.

pgvector supports iterative HNSW scans, which continue exploring the graph when filters remove candidates. It offers `strict_order`, which preserves distance ordering, and `relaxed_order`, which can improve recall or performance at the cost of ordering guarantees. Exact rank order matters because hybrid search converts each search arm's order into Reciprocal Rank Fusion ranks.

The setting is a pgvector custom PostgreSQL parameter. Such parameters are registered lazily when pgvector loads in a database connection. A function-level `SET hnsw.iterative_scan ...` clause is validated when the function is created. During an existing-database migration, pgvector may not yet be loaded on that connection, and a non-superuser migration role can be denied permission to set the unrecognized parameter.

Semantic search enables pgvector iterative scans in `strict_order` mode before executing its vector query:

```sql
perform set_config('hnsw.iterative_scan', 'strict_order', true);
```

The call is made inside the vector branch of the search function. Its third argument makes the setting transaction-local. It is not declared as a function-level `SET` clause.

`strict_order` is used instead of `relaxed_order` so returned semantic candidates remain ordered by cosine distance before ranks are assigned. The vector arm of hybrid search calls the same semantic search function and inherits this behavior.

`hnsw.ef_search`, `hnsw.max_scan_tuples`, and `hnsw.scan_mem_multiplier` remain at their configured defaults. With iterative scanning enabled, `ef_search` is primarily a performance tuning parameter rather than the initial candidate window becoming a correctness boundary. Further tuning requires workload-specific benchmarks.

## Invariants and constraints

- Filtered semantic searches continue scanning for qualifying candidates instead of stopping after filters shrink the initial HNSW candidate set.
- Direct semantic search and the semantic arm of hybrid search share the same recall behavior.
- Candidates preserve strict distance order, which keeps hybrid rank assignment deterministic for a given candidate set.
- Iterative scanning can inspect more graph tuples and increase query latency when filters are selective.
- Search remains bounded by the requested result limit and pgvector's scan limits. It improves filtered recall but does not make approximate nearest-neighbor search exhaustive.
- The parameter is set at query time because a function-level `SET` clause can fail migration when pgvector has not registered its custom parameters on that connection.
- `hnsw.ef_search`, `hnsw.max_scan_tuples`, and `hnsw.scan_mem_multiplier` retain their configured defaults until workload-specific benchmarks justify tuning them.
