---
title: Use cosine similarity for semantic search scores
status: Accepted
date: 2026-08-07
deciders: [jgpruitt]
tags: [search, semantic-search, pgvector, scoring]
tickets: []
supersedes: []
---

# ADR 0001: Use cosine similarity for semantic search scores

## Context

Memory Engine uses pgvector's cosine distance operator, `<=>`, to rank semantic search results. Cosine distance is `1 - cosine similarity`, so lower distance is better and its range is `[0, 2]`. Cosine similarity has the inverse interpretation: higher is better and its range is `[-1, 1]`.

The database previously returned negated cosine distance as the public score:

```text
score = -(embedding <=> query) = cosine similarity - 1
```

This preserved ranking, but produced values in `[-2, 0]` that were neither cosine distance nor cosine similarity. It also conflicted with the public `semanticThreshold` parameter, which was documented as a minimum similarity in `[0, 1]`.

The HNSW index adds another constraint. PostgreSQL can use the cosine HNSW index for an ascending `ORDER BY embedding <=> query LIMIT ...`. Applying a transformation to the ordering expression can make the index ineligible.

## Decision

Semantic search returns cosine similarity:

```text
score = 1 - (embedding <=> query)
```

The returned score is in `[-1, 1]`, and higher values mean greater similarity. The query continues to order by the raw `<=>` distance operator so that the HNSW index remains eligible:

```sql
select 1 - (embedding <=> query) as score
from memory
order by embedding <=> query
limit result_limit;
```

The public threshold and internal interfaces use similarity terminology. `semanticThreshold` is a minimum cosine similarity in `[0, 1]`. The database converts it once to the operator's native maximum-distance bound:

```text
maximum distance = 1 - minimum similarity
```

Values outside `[0, 1]` are rejected rather than clamped. Validation occurs at both the public protocol boundary and the database boundary so direct database callers receive the same contract.

## Consequences

- Semantic scores have a standard mathematical meaning and agree with `semanticThreshold`.
- Existing ranking is unchanged because cosine similarity is a monotonic transformation of cosine distance.
- The HNSW index remains eligible because only the projected score is transformed; ordering uses the raw distance operator.
- Callers can compare semantic scores within a result set and use an intuitive absolute quality threshold. Scores are not intended for comparison with BM25 or hybrid scores.
- Although returned cosine similarity can be negative, the public threshold deliberately accepts only `[0, 1]`. The threshold is a relevance filter, not a way to request results that point away from the query vector.

## Alternatives considered

### Return cosine distance

Returning the raw distance would match pgvector's operator directly, but it would reverse the product's established "higher is better" score convention and the public minimum-similarity vocabulary.

### Keep negated cosine distance

Negated distance preserves ordering, but its `[-2, 0]` range has no standard interpretation and conflicts with the public threshold contract.

### Transform the `ORDER BY` expression

Ordering by the projected similarity would read naturally, but risks preventing PostgreSQL from selecting the HNSW index. Transforming only the projection provides the same result order without that risk.

### Clamp invalid thresholds

Clamping would hide caller errors and could silently turn a malformed request into a much broader or narrower search. Rejecting invalid values makes the contract explicit.
