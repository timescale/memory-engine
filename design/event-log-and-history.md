---
title: Event Log, History, and Revert
tags: [memory, audit, history, revert, event-log, embeddings, spaces]
---

# Event Log, History, and Revert

Every space records an append-only audit log of its memory mutations in a
`memory_event` table alongside the `memory` table. Each insert, update, and
delete becomes one immutable event, so the log answers who changed a memory,
when, how, and — crucially — who deleted it. The history read surface and the
`revert`/undelete operations are both built on this log.

## Append-only, not prior-state archival

The log stores an event per mutation, not a "previous version" row written when a
state is superseded. This distinction matters at deletion. An archival model that
copies the old row when it is replaced has no landing spot for the final version's
author when the row is deleted, so it tends to lose or overwrite that attribution.
An append-only log treats delete as just another event with its own actor, so no
version's author is ever lost.

A single `AFTER INSERT OR UPDATE OR DELETE` trigger writes each event. It captures
a full snapshot of the state the mutation produced — for a delete, the removed
state — plus the columns needed to interpret it:

| Field | Meaning |
| --- | --- |
| `event_id` | UUIDv7 identity of the event; a unique, chronological total order. |
| `at` | Event time (`clock_timestamp`), the hypertable partitioning column. |
| `memory_id` | The memory the event belongs to; outlives the memory itself. |
| `operation` | The physical row change: `insert`, `update`, or `delete`. |
| `operation_id` | Shared across every row of one statement — correlates bulk operations. |
| `cause` | App-level intent (`create`, `update`, `delete`, `move`, `revert`, …). |
| `actor` | Who performed the mutation (see Attribution); `{}` for unattributed writes. |
| snapshot | `tree`, `name`, `meta`, `temporal`, `content`, `content_version`, `version`, `version_hash`. |

An update that changes nothing meaningful is not logged; the trigger only records
a change to tree, name, metadata, temporal value, or content. The trigger runs
after the version triggers, so the snapshot carries the resulting `version` and
`version_hash`.

## Attribution

The actor is not read from the row; the request layer establishes a
transaction-local `me.event_context` GUC before each externally initiated
mutation, and the trigger reads it. This keeps the space SQL functions
themselves untouched — attribution is a property of the transaction, not an
argument threaded through every write path.

The context carries the authenticated principal's id and display name and, for
api-key auth, the key's id and name; these are resolved once during
authentication and propagated into the request context. `cause` records the
API-level intent, distinct from the physical `operation`. A generated
`operation_id` is stamped once per transaction so every row of a bulk statement
shares it.

Direct database activity (migrations, ad-hoc DBA work) sets no context. Such
events are still logged with a generated `operation_id` for correlation but an
empty `actor` and null `cause` — attribution is optional, not required, and its
absence is itself meaningful.

## Storage, indexes, and retention

The log is optionally a TimescaleDB hypertable partitioned by `at`. When the
extension is absent the migration degrades to a plain table with identical
semantics; see [Database migrations and versioning](database-migrations-and-versioning.md).

The dominant reads are entity lookups (by `memory_id`, `operation_id`, subtree)
and a time-ordered feed. Both are indexed so that, on the hypertable, entity
lookups are cheap per-chunk index probes rather than scans:

| Access | Index |
| --- | --- |
| One memory's history | Primary key `(memory_id, at, event_id)`. |
| A bulk operation's rows | `(operation_id)`. |
| A subtree's events | GiST over `tree`. |
| Path resolution for a deleted memory | `(tree, name)`. |
| Time feed / window | `(at desc)`, created explicitly so it exists on the plain-table path too. |

A retention policy drops events older than 30 days. This bounds the log's growth
but also bounds history and revert: only mutations within the retention window
are visible or restorable.

## History reads

History is gated per event by read access to that event's own tree, consistent
with [Memory authorization](memory-authorization.md). An event whose tree the
caller cannot read is never returned, so the history of a memory that moved
between trees may appear partial to a caller who lacks read on some of its
historical trees. This per-event gating never leaks a snapshot from an
unreadable tree. Deleted memories remain readable, because their events outlive
the row.

A read requires at least one scope — a memory id, a `tree/name` path, a subtree,
an `operation_id`, or a `since` bound — so a bare unbounded scan is rejected. A
`since` alone drives a space-wide activity feed. An optional `operation` narrows
within a scope, and `since`/`until` bound the window on event time. The date
bounds are expressed as monotone comparisons on `at` so the hypertable can prune
chunks.

Results order by `event_id`. Because UUIDv7 is a unique, chronological total
order, ordering by it lets a keyset cursor seek on `event_id` alone and match the
sort exactly. This avoids both the timestamp-precision loss of a millisecond
cursor and the ordering mismatch of seeking on one column while sorting by
another; `at` still drives the window and chunk pruning. Every query is
scope-bounded, so ordering operates on a bounded candidate set.

A path resolves to a memory id live first, then through the log, so a deleted
memory's history is reachable by its old `tree/name` path. When a `(tree, name)`
slot has been reused, the live memory wins.

## Revert and undelete

Revert restores a memory's current state to the snapshot recorded for a chosen
version, applied as a new forward version. It reproduces an earlier state; it
does not rewrite history. The restore is itself logged, with `cause = revert`.

The full snapshot is restored — `content`, `meta`, `tree`, `name`, and
`temporal` — so a revert can move a memory back to an earlier tree, or fail with
a conflict if the snapshot's `(tree, name)` slot is now occupied. Restoring the
full snapshot means access is checked like a move: write on the current tree and,
when the target version lived elsewhere, on the snapshot tree too.

Revert is a deliberate override rather than an optimistic-concurrency operation.
It does not require the current `version_hash`; a caller may still pass an
expected hash to guard against a concurrent change to a live memory. Reverting to
the memory's current state is a no-op.

A deleted memory is reachable by id or by path, and reverting it re-creates it —
undelete falls out of the same operation. This is why an ordinary insert no
longer forces `version = 1`: an undelete re-inserts with an explicit version, so
the id's version sequence continues rather than restarting. Both server-managed
sequences continue from history:

- `version`, the logical-payload version, continues so a later revert can address
  restored versions unambiguously.
- `content_version`, the embedding-queue guard token, continues for correctness.
  A reset to `1` could collide with a pre-delete version still being processed by
  the embedding worker; because write-back is guarded on `content_version`, a
  stale embedding could win. Continuing past the historical maximum guarantees any
  in-flight pre-delete completion fails the guard. See
  [Embedding queue and worker](embedding-queue-and-worker.md).

Only versions within the retention window are restorable; an out-of-window or
unreadable version resolves to not-found.

## Consequences

- The author of every version is preserved, including the state a memory was in
  when it was deleted.
- History and revert reach back exactly as far as the retention window; the log
  is not an unbounded archive.
- Entity lookups and the time feed are both first-class: the log is queried by
  who/what as well as by when.
- Undelete is not a separate mechanism — it is revert of a deleted memory, with
  version and content-version sequences continued so identity, later reverts, and
  embedding stay consistent.
