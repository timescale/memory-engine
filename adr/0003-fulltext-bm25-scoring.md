---
title: Return only positive BM25 matches from fulltext search
status: Accepted
date: 2026-08-07
deciders: [jgpruitt]
tags: [search, fulltext-search, bm25, pg-textsearch]
tickets: []
supersedes: []
---

# ADR 0003: Return only positive BM25 matches from fulltext search

## Context

Memory Engine uses pg_textsearch's BM25 operator, `<@>`, for fulltext ranking. The operator returns negative BM25 so that an ascending PostgreSQL index scan visits the most relevant rows first. Memory Engine negates that value when returning it, producing a positive, higher-is-better BM25 score.

For the configured BM25 variant, term contributions are non-negative and a document containing none of the query stems scores exactly zero. The English text configuration lowercases and stems terms and removes stop words, so "match" here means that at least one processed query stem occurs in the processed document.

An ordered top-k query does not inherently exclude zero-score rows:

```sql
order by content <@> query
limit result_limit
```

When fewer genuine matches exist than the requested limit, PostgreSQL can fill the remainder with zero-score non-matches. This is a property of the top-k ordering and occurs whether PostgreSQL uses the BM25 index or a sequential scan.

Zero-score rows are especially harmful in hybrid search. Once assigned a rank, a non-match receives a positive Reciprocal Rank Fusion contribution despite having no lexical match.

## Decision

Fulltext search enforces an unconditional positive-BM25 invariant:

```sql
and (content <@> query) < 0
```

Because `<@>` returns negative BM25, this predicate is equivalent to requiring returned BM25 to be greater than zero. Fulltext search therefore returns only documents containing at least one processed query stem.

The predicate is applied while preserving the required `ORDER BY content <@> query LIMIT ...` shape. PostgreSQL can continue to use the BM25 index for ranking, with the positive-match condition applied as a filter.

Memory Engine does not expose a `fulltextThreshold` parameter. The returned fulltext score remains positive, unnormalized BM25 and is meaningful for ranking results within a query, not as a stable absolute relevance scale.

## Consequences

- Fulltext results contain genuine lexical matches only; the result limit is a maximum rather than a target padded with non-matches.
- Hybrid search no longer gives zero-score lexical non-matches a positive fused contribution merely because they occupied a candidate slot.
- Queries containing only stop words produce no processed terms and return no results.
- Returned scores remain unbounded and depend on query terms, term frequency, document length, and corpus-wide document frequency.
- Callers cannot set an absolute BM25 quality threshold. They can raise the result limit to retrieve more genuine lexical matches, up to the search result cap.

## Alternatives considered

### Preserve zero-score rows

Returning exactly the requested number of rows can appear convenient, but rows with no query stems are not fulltext matches. Including them misrepresents relevance and contaminates hybrid ranking.

### Expose an absolute `fulltextThreshold`

BM25 has no corpus- and query-independent scale. A value that is selective for one query can reject everything or almost nothing for another, and corpus changes can move scores over time. Exposing such a threshold as an intuitive public quality control would be misleading.

### Use a relative threshold based on the top result

A relative cutoff could adapt to each result set, but it would define a different feature with behavior tied to the top match and candidate window. It is not needed to enforce the correctness invariant that non-matches must be excluded.

### Filter after retrieving the top-k rows

Filtering outside the ranked query would still prevent non-matches from reaching callers, but it could leave fewer useful rows without letting the index continue to consider later matches. Keeping the predicate in the ranked query lets PostgreSQL apply it as part of candidate selection while preserving index eligibility.
