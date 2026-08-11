---
title: Fulltext BM25 Scoring
tags: [search, fulltext-search, bm25, pg-textsearch]
---

# Fulltext BM25 Scoring

## Score semantics

Memory Engine uses pg_textsearch's BM25 operator, `<@>`, for fulltext ranking. The operator returns negative BM25 so that an ascending PostgreSQL index scan visits the most relevant rows first. Memory Engine negates that value when returning it, producing a positive, higher-is-better BM25 score.

For the configured BM25 variant, term contributions are non-negative and a document containing none of the query stems scores exactly zero. The English text configuration lowercases and stems terms and removes stop words, so "match" here means that at least one processed query stem occurs in the processed document.

An ordered top-k query does not inherently exclude zero-score rows:

```sql
order by content <@> query
limit result_limit
```

When fewer genuine matches exist than the requested limit, PostgreSQL can fill the remainder with zero-score non-matches. This is a property of the top-k ordering and occurs whether PostgreSQL uses the BM25 index or a sequential scan.

Zero-score rows are especially harmful in hybrid search. Once assigned a rank, a non-match receives a positive Reciprocal Rank Fusion contribution despite having no lexical match.

Fulltext search enforces an unconditional positive-BM25 invariant:

```sql
and (content <@> query) < 0
```

Because `<@>` returns negative BM25, this predicate is equivalent to requiring returned BM25 to be greater than zero. Fulltext search therefore returns only documents containing at least one processed query stem.

The predicate is applied while preserving the required `ORDER BY content <@> query LIMIT ...` shape. PostgreSQL can continue to use the BM25 index for ranking, with the positive-match condition applied as a filter.

Memory Engine does not expose a `fulltextThreshold` parameter. The returned fulltext score remains positive, unnormalized BM25 and is meaningful for ranking results within a query, not as a stable absolute relevance scale.

## Invariants and constraints

- Fulltext results contain genuine lexical matches only; the result limit is a maximum rather than a target padded with non-matches.
- Hybrid search never gives zero-score lexical non-matches a fused contribution merely because they occupied a candidate slot.
- Queries containing only stop words produce no processed terms and return no results.
- Returned scores are unbounded and depend on query terms, term frequency, document length, and corpus-wide document frequency.
- There is no `fulltextThreshold`: BM25 has no corpus- and query-independent quality scale. Raising the result limit retrieves more genuine lexical matches, up to the search result cap.
- The positive-match predicate remains in the ranked query so PostgreSQL can consider later matches while preserving the BM25 index ordering.
