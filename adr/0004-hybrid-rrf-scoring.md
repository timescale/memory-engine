---
title: Use Reciprocal Rank Fusion without a fused-score threshold
status: Accepted
date: 2026-08-07
deciders: [jgpruitt]
tags: [search, hybrid-search, reciprocal-rank-fusion, scoring]
tickets: []
supersedes: []
---

# ADR 0004: Use Reciprocal Rank Fusion without a fused-score threshold

## Context

Semantic search returns bounded cosine similarity, while fulltext search returns unbounded BM25 scores whose scale depends on the query and corpus. Adding the raw scores would allow whichever scoring system produces larger numbers to dominate, even when that scale does not represent greater relevance.

Memory Engine combines the two search modes with Reciprocal Rank Fusion (RRF). Each arm first produces an independently ranked candidate set. The sets are joined by memory ID, and each result receives this score:

```text
score = fulltext_weight / (k + fulltext_rank)
      + semantic_weight / (k + semantic_rank)
```

A missing arm contributes zero. The defaults are `k = 60`, equal weights, and 30 candidates per arm. Candidate limits are always at least the requested result limit and are bounded by the search result cap.

RRF deliberately discards raw scores and uses rank. This normalizes the incomparable semantic and BM25 scales and rewards results that rank well in both arms. It also means the fused score is determined by position within the candidate windows, not by an absolute relevance measurement.

## Decision

Hybrid search uses weighted RRF over the semantic and fulltext candidate rankings. The fused score is exposed for ordering and inspection, but Memory Engine does not expose an `rrfThreshold` parameter.

Search quality is controlled before fusion:

- Fulltext candidates must have positive BM25 scores, so every candidate is a genuine lexical match.
- `semanticThreshold` can set an absolute minimum cosine similarity for semantic candidates.
- `candidateLimit` controls how many candidates each arm contributes.
- Semantic and fulltext weights bias the contribution of each arm.
- The final `limit` controls the maximum number of fused results.

Hybrid search is defined as a fused top-k operation, not an exhaustive retrieval interface. Callers that need as many results as possible above a quality bar should use a single search mode with a larger limit: semantic search with `semanticThreshold`, or fulltext search with its positive-match invariant. Truly exhaustive retrieval requires a separate paginated design.

## Consequences

- Hybrid search can combine semantic and lexical rankings without normalizing or calibrating their raw score distributions.
- Results appearing in both arms generally receive more weight than results appearing in only one arm. This cross-arm agreement is intentional.
- The hybrid score is a small positive rank-fusion value. It is comparable only within the same result set and is not an absolute relevance score.
- Changing `k`, weights, candidate limits, or competing candidates can change a memory's fused score even when its content and query are unchanged.
- There is no intuitive fixed threshold for "good" hybrid results. Callers tune the input arms and result limits instead.
- Raising `candidateLimit` broadens the fusion pool and can increase query cost; it still does not make hybrid search exhaustive.

## Alternatives considered

### Add or average raw semantic and BM25 scores

The raw score scales are incompatible. Cosine similarity is bounded, while BM25 is unbounded and corpus-dependent. A numeric combination would require calibration that changes with queries and corpus composition.

### Expose an `rrfThreshold`

An RRF threshold would filter rank position within a particular candidate window, not absolute relevance. The useful numeric range shifts with `k`, weights, candidate limits, and whether a result appears in one or both arms. Such a parameter would be difficult to set by intuition and would not satisfy requests for every result above a relevance bar.

### Make hybrid search exhaustive when a threshold is present

RRF is computed after each arm has been truncated to its candidate set. A post-fusion threshold cannot recover records that were never candidates. Making the candidate sets unbounded would introduce a substantially different and potentially expensive query model that needs pagination and explicit resource controls.

### Prefer one arm when scores disagree

Always preferring semantic or fulltext ranking would discard the benefit of hybrid retrieval. Adjustable weights already let callers express a preference while retaining evidence from both modes.
