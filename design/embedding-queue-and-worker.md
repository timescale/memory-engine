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

## Runtime ownership

The default API server starts an embedded worker pool (`WORKER_COUNT=2`),
preserving the single-process self-hosted setup. Setting `WORKER_COUNT=0`
disables background queue consumers entirely: the API creates no worker DB
pool and performs no worker discovery. Memory writes still enqueue through
Postgres triggers. Semantic search still generates its query embedding on the
request path, so API-only mode still needs embedding-provider configuration
and can use tokenizer threads.

For separate processes, `./bun run worker` runs
`packages/server/worker.ts`; the existing server image can use the command
`bun run packages/server/worker.ts` without a separate image build. This is a
backend entrypoint, not a `me` CLI command (`me serve` is a local UI proxy).
The callable bootstrap is `startEmbeddingWorkers()` in
`packages/server/worker-start.ts`.

Standalone workers require a positive `WORKER_COUNT` (default 2),
`DATABASE_URL` for core space discovery, and the same `EMBEDDING_*` provider
settings/model as the API. `WORKER_DATABASE_URL` optionally overrides the
connection used for queue processing; it must address the same logical data.
The worker queue pool uses `WORKER_DB_*` settings, falling back to the existing
DB pool lifetime/idle/connect settings, and discovery uses a separate pool of
one connection. `CORE_SCHEMA` is honored in both modes. Worker startup validates
space discovery but does **not** migrate schemas: deploy/migrate the matching
API version first. Workers start no auth stack, cleanup cron, or public HTTP
listener, and require no API URL, auth signing secret, or OAuth credentials.

Independent processes coordinate through the existing queue claims; there is
no in-memory work handoff, leader election, or permanent space assignment.
Effective background concurrency is `worker replicas × WORKER_COUNT`, plus
any embedded workers still running in API replicas. Rate-limit gates are
process-local, not a provider-wide quota across the fleet.

Both entrypoints apply the same telemetry scrubbing policy, with standalone
workers reporting under `memory-engine-worker` rather than `memory-engine`.
SIGINT/SIGTERM stops new queue claims and drains in-flight batches before
closing pools and tokenizer threads. The orchestrator must allow sufficient
termination grace for provider/DB timeouts and batch write-back. A killed
process still relies on queue visibility expiry for recovery.

### Lifecycle failures and health

Initial discovery failures reject startup and release allocated pools. Worker
loop failures outside the normal batch retry path (for example, failed
periodic discovery) are exposed through the running handle's `finished`
promise; the process entrypoints drain and exit nonzero rather than leave a
live process with dead consumers. Programmatic callers must observe `finished`
and stop the handle. Ordinary batch failures and provider 429s retain their
existing retry/backoff behavior.

The standalone command currently has **no HTTP health endpoint**. Process
failure is observable via its exit status, but process liveness alone does not
prove work is progressing. Empty queues and rate-limit backoff are normal idle
states, not reasons to restart a worker. Queue age, outcomes, restarts, and
per-role memory remain the operational signals; HTTP readiness or heartbeat
probes can be added separately when the worker Deployment is introduced.

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

The `embedding.generate_batch` and worker `embedding.batch` spans include numeric
`batch.input_bytes`: the sum of UTF-8 byte lengths of the original input strings,
before truncation. This measures text payload size, not JSON request size, vector
size, heap usage, or RSS. The attribute name deliberately avoids `content` and
`embedding`, which the telemetry privacy scrubber treats as sensitive keys. No
input text, queries, or credentials are added by this instrumentation, and it
does not serialize payloads or allocate byte-buffer copies to measure them.

`getTokenizerPoolStats()` (exported by the embedding package) provides a
constant-time, numeric-only snapshot for the runtime metrics sampler:

| Field | Meaning |
| --- | --- |
| `threads` | Live pool worker slots; zero before lazy initialization and after shutdown, not the configured maximum. |
| `activeJobs` | Jobs dispatched to tokenizer workers and awaiting a result. |
| `queuedJobs` | Jobs waiting for a free tokenizer worker. |
| `activeInputBytes` | UTF-8 input bytes belonging to active jobs. |
| `queuedInputBytes` | UTF-8 input bytes belonging to waiting jobs. |

Sampling does not create workers or parse thread configuration. Each job's byte
length is counted once with `Buffer.byteLength`, then transferred between queued
and active totals on dispatch and removed on completion or failure. Shutdown
clears both totals. Worker errors, unexpected exits, malformed responses, and
failed message sends release active accounting while preserving the existing
inline-tokenization fallback. A failed replacement cannot strand queued jobs if
no workers remain. Pool initialization also cleans up partially spawned pools.
The snapshot counts managed worker slots: a retiring failed worker may briefly
still be terminating after its replacement is installed. It is not an OS thread
census or an estimate of tokenizer dictionary/worker heap memory. Inline fallback
work is synchronous and is not counted as active pool work. Stats retain no new
text references and export no per-job identifiers or labels.

Per-tokenization-job spans are deliberately omitted to avoid adding span volume
on every search; these aggregate snapshots provide the queue-pressure signal.
The existing embedding spans still cover batch processing duration.
