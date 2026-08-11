---
title: Embedding Queue and Worker
tags: [embeddings, queue, worker, semantic-search, spaces]
---

# Embedding Queue and Worker

Embedding generation is asynchronous so memory writes do not wait for an
embedding provider. A new or changed memory is stored immediately and remains
available to fulltext and filter-based search. It becomes eligible for semantic
search after the worker writes its vector.

Every space owns its own embedding queue alongside its memory table. This keeps
queue work, lifecycle, and cleanup within the same isolation boundary as the
memories it represents.

## Enqueueing

The queue records a memory ID and its `content_version`. Database triggers enqueue
work when:

- A memory is inserted without an embedding.
- A memory's content changes and its embedding is reset.

An insert that already supplies an embedding does not enqueue work. Content
versions make a queue entry refer to one exact memory state, rather than merely
to a memory ID.

## Claiming and staleness

Workers claim visible queue rows in batches. A claim increments the attempt count
and moves a row's visibility time into the future, preventing concurrent workers
from processing it. Claims use `FOR UPDATE SKIP LOCKED`, so workers can drain the
same queue without blocking one another.

Before claiming, the queue cancels rows that are no longer useful:

- A newer pending content version exists for the same memory.
- The memory was deleted or its content version no longer matches.

The worker embeds outside the claim transaction. If it crashes before write-back,
the visibility timeout expires and another worker can claim the row. A sweep marks
rows that exhausted their attempt budget as failed, including rows stranded by a
crash after their final claim.

## Write-back and retries

Write-back is version-guarded and atomic. A completed embedding is written only
when the memory still has the claimed content version. Otherwise the queue row is
cancelled and no stale vector is stored. Deleting a memory also removes its queue
rows through the foreign-key cascade.

Ordinary provider or write-back failures record the last error while leaving the
row pending. It becomes eligible for another claim after its visibility timeout.
This makes the queue, rather than the embedding SDK, the primary retry authority.

Rate limits are treated separately from ordinary failures. The worker releases
claimed rows, refunds their attempt count, and defers their visibility by the
same backoff interval that the worker observes. Workers in one pool also share a
rate-limit gate, so one provider `429` pauses new claims across the pool. The
database visibility delay prevents another worker or process from immediately
reclaiming the same rows.

## Worker operation

Workers periodically discover space schemas and poll their queues in shuffled
round-robin order. They process immediately while work exists, sleep while idle,
and apply bounded exponential backoff for consecutive non-rate-limit failures.
An optional drain timeout lets a worker exit after sustained idleness.

Queue functions own claiming, completion, failure, release, and pruning. The
worker calls those functions rather than issuing inline queue mutations, keeping
the queue state machine in the database.

Terminal queue rows are retained for seven days by default, then pruned
opportunistically when a worker finds no claimable work in that space. This
preserves short-term failure and cancellation visibility without unbounded queue
growth.

## Operational visibility

The embedding status surface reports aggregate queue state for the active space:

| State | Meaning |
| --- | --- |
| Pending | Queue rows without a terminal outcome. |
| In flight | Pending rows whose visibility timeout is still in the future. |
| Waiting | Pending rows that are claimable now. |
| Failed | Terminal failures retained before pruning. |

It also reports the oldest pending enqueue time. These are space-wide operational
counts, not tree-scoped memory results.
