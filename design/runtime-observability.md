---
title: Runtime and OOM Observability
tags: [server, telemetry, logfire, operations]
---

# Runtime and OOM Observability

The production server entrypoint configures Logfire before booting the server.
It starts a process-wide memory sampler immediately, including during database
migrations, and stops it after graceful server shutdown. `startServer()` remains
free of process-global telemetry configuration so in-process harnesses do not
install extra timers or change global providers.

All new measurements use the existing Logfire/OpenTelemetry providers and token.
There is no second exporter, HTTP listener, telemetry endpoint, heap snapshot,
production database query, or payload logging. A telemetry failure must not turn
an otherwise successful request into a failure.

## SDK compatibility

The server explicitly supplies **all** Logfire peers, rather than relying on Bun
retaining previously installed auto-peers outside Logfire's supported ranges.
The installed stack is `@pydantic/logfire-node` 0.18.29 (`logfire` 0.23.0), OTel API
1.9.1, stable SDK/core/resources/context packages 2.12.0, experimental
SDK/exporters/instrumentation/API-logs 0.223.0, node auto-instrumentations 0.81.1,
and semantic conventions 1.43.0. Runtime gauges, HTTP instruments, SDK readers,
and public SDK flushes use the same provider. Tests check installed peer ranges
and identical resolved module paths across database/embedding/engine/server/worker.

OTel's 0.223 transformer uses upstream custom protobuf serialization rather than
`protobufjs`. The remaining protobuf runtime is in NodeSDK's optional gRPC
exporter branch: `@grpc/grpc-js` 1.14.6 → `@grpc/proto-loader` 0.8.0 → `protobufjs`
7.6.6 (`@protobufjs/utf8` 1.1.2). These are compatible updates within upstream
dependency ranges, not forced major-version overrides. The lockfile updates
remove the known protobuf/gRPC audit findings; this is not a claim that the
whole workspace audit is clean.

## Identity

Before Logfire's environment resource detector runs, the entrypoint adds missing
attributes to `OTEL_RESOURCE_ATTRIBUTES`:

- `service.instance.id`: a random UUID per process start. This distinguishes both
  replicas and successive lifetimes, even when Kubernetes reuses a pod name.
- `process.pid`, `process.runtime.name` (`bun`), `process.runtime.version`.
- `k8s.pod.name`: `POD_NAME`, or `HOSTNAME` when `KUBERNETES_SERVICE_HOST` is set.
- `k8s.pod.uid`: `POD_UID`, when supplied.
- `k8s.namespace.name`: `NAMESPACE`, when supplied.

Explicit operator attributes are preserved, including an explicit instance ID.
An operator-supplied stable instance ID therefore opts out of unique per-start
identity. Existing environment and service-version configuration is unchanged.
These identities are resource attributes, not additional metric point labels.

For complete Kubernetes identity, deployment configuration should expose the
Downward API (the application does not call the Kubernetes API):

```yaml
env:
  - name: POD_NAME
    valueFrom:
      fieldRef:
        fieldPath: metadata.name
  - name: POD_UID
    valueFrom:
      fieldRef:
        fieldPath: metadata.uid
  - name: NAMESPACE
    valueFrom:
      fieldRef:
        fieldPath: metadata.namespace
```

This repository change does not modify the separate deployment charts.

## Runtime measurements

Every 10 seconds, and once at startup, the sampler captures a bounded numeric
snapshot. Nonoverlapping asynchronous filesystem reads keep slow/unavailable
procfs/cgroup files from accumulating work. The timer is unref'd; shutdown aborts
pending reads and performs a best-effort final metric flush with a one-second
budget before removing observation callbacks.

Metrics are observable gauges, with no point labels:

| Metric | Unit / interpretation |
| --- | --- |
| `memory_engine.process.memory.rss` | Bytes resident for the process. |
| `memory_engine.process.memory.heap_used` | Bytes reported by Bun's `process.memoryUsage().heapUsed`. |
| `memory_engine.process.memory.heap_total` | Bytes reported by `heapTotal`. |
| `memory_engine.process.memory.external` | Bytes reported by `external`. |
| `memory_engine.process.memory.array_buffers` | Bytes reported by `arrayBuffers`, when available. |
| `memory_engine.process.uptime` | Seconds since process startup. |
| `memory_engine.cgroup.memory.usage` | Leaf cgroup memory usage in bytes; not process RSS. |
| `memory_engine.cgroup.memory.limit` | Leaf finite memory limit in bytes. |
| `memory_engine.cgroup.memory.peak` | Leaf peak memory usage in bytes, when supported. |
| `memory_engine.cgroup.memory.events.oom` | Absolute kernel OOM event count, when available. |
| `memory_engine.cgroup.memory.events.oom_kill` | Absolute kernel OOM-kill count, when available. |
| `memory_engine.cgroup.memory.effective_limit` | Minimum finite cgroup-v2 `memory.max` across the leaf and visible ancestors. |
| `memory_engine.cgroup.memory.limiting.usage` | Usage of the cgroup supplying that minimum limit. |
| `memory_engine.cgroup.memory.limiting.events.oom` | Absolute OOM event count for that limiting cgroup. |
| `memory_engine.cgroup.memory.limiting.events.oom_kill` | Absolute OOM-kill count for that limiting cgroup. |
| `memory_engine.tokenizer.threads` | Managed tokenizer worker slots, not configured maximum or total OS thread count. |
| `memory_engine.tokenizer.active_jobs` | Tokenizer jobs dispatched and awaiting a result. |
| `memory_engine.tokenizer.queued_jobs` | Jobs waiting for a tokenizer worker. |
| `memory_engine.tokenizer.active_input` | UTF-8 input bytes belonging to active jobs. |
| `memory_engine.tokenizer.queued_input` | UTF-8 input bytes belonging to waiting jobs. |

Cgroup resolution uses `/proc/self/cgroup` and `/proc/self/mountinfo`, including
mount roots and namespace-relative membership. Conventional container-root paths
are fallbacks when discovery is unavailable. Cgroup v1 supports leaf usage,
limit, peak, and available OOM-kill counters; `under_oom` is not an event count.
Cgroup v2 also checks ancestors up to the visible mount root, never outside it.
Unlimited, unsupported, inaccessible, malformed, or unsafe numeric values are
omitted rather than exported as zero. A missing cgroup limit does not mean zero
memory is available.

Ancestor measurements may include sibling containers/processes. Do not divide
leaf usage by an ancestor's limit and call that ancestor utilization; use the
paired limiting-cgroup usage instead. Hidden host ancestors, cgroup-v1 inherited
limits, swap, and node-wide pressure are not fully represented. The smallest
finite byte limit is not necessarily the ancestor nearest to exhaustion.

Bun's JS memory categories are runtime-reported diagnostics, not V8 heap
statistics. RSS, heap, external memory, and ArrayBuffer measurements are not
necessarily disjoint; do not sum them into a total or label their difference a
proven leak. Worker dictionaries/native allocations can raise RSS without raising
main-thread JS heap usage.

### Export cadence and structured samples

The installed Logfire 0.18 / OTel 2.12 reader still has its own 60-second export
timer and does not consume `OTEL_METRIC_EXPORT_INTERVAL`. The sampler supplements
it with Logfire's public `forceFlush()` API, reaching the SDK's existing readers
and pending spans/logs without probing private global-provider methods. It
defaults the env setting to `10000` milliseconds only when absent; explicit values
are preserved. Supplementary flushes occur on sampling ticks, are clamped to a
minimum of one sampling interval, and round up to that resolution.
Invalid/nonpositive values fall back to the greater of 10 seconds and the sample
interval. Longer settings do not disable the SDK's 60-second timer. Only one
supplementary flush runs at a time, without blocking memory sampling. No-token
export callbacks now complete, so public flush/shutdown also support in-memory
additional readers in no-export configurations.

Before configuration, the entrypoint defaults `OTEL_LOGS_EXPORTER` and
`OTEL_METRICS_EXPORTER` to `none`, preserving explicit operator settings. NodeSDK
0.223 otherwise creates implicit localhost OTLP exporters when Logfire omits a
signal (no-token log processors, or `metrics: false`). These defaults do **not**
disable Logfire's explicitly configured readers/processors when a token is
present. There is still no second metrics provider or exporter.

On boot failure and graceful shutdown, the sampler first flushes its final
snapshot before removing gauge callbacks (one-second budget), then the entrypoint
calls public `shutdown({ timeoutMillis: 1000 })` to close every SDK signal. This
also covers SIGINT/explicit exit, where `beforeExit` is not emitted. Isolated
real-SDK tests exercise no-token in-memory readers and a loopback OTLP collector:
default 60-second reader registration, supplementary cadence, metric/resource and
span export, final flush, idempotent shutdown, and natural process exit.

A `Runtime memory sample` structured Logfire event accompanies each completed
sample. Its attributes are the numeric keys from `RUNTIME_METRICS` in
`packages/server/runtime-telemetry.ts` (for example `rss`, `heapUsed`,
`cgroupUsage`, `cgroupEffectiveLimit`, `tokenizerQueuedInputBytes`). This gives a
second queryable view of the same samples, not additional sensitive data. It
adds approximately six small events per minute per process. Logfire buffering,
sampling, network failure, or SIGKILL can still lose the final sample.

## HTTP and RPC measurements

| Signal | Location / interpretation |
| --- | --- |
| `memory_engine.http.requests.active` | UpDownCounter with no point labels. Active inbound handler lifetimes, **not** active socket/network flush lifetimes. |
| `memory_engine.http.requests.completed` | Counter labeled only by fixed HTTP route/method buckets, status, and outcome. |
| `memory_engine.http.response.body.size` | Histogram of UTF-8 JSON response bytes, with byte-appropriate buckets through 64 MiB. |
| `memory_engine.http.response.serialization.duration` | Histogram of `JSON.stringify` duration in milliseconds. |
| `http.response.status_code`, `http.outcome` | Attributes on completed `http.request` spans. |
| `http.response.body.size`, `response.serialization.duration_ms` | Attributes on HTTP/RPC spans for measured JSON responses. |
| `space.slug` | Authenticated space on RPC spans only, not a metric label or caller-supplied body/header value. |
| `principal.id`, `principal.kind` | Authenticated caller on RPC spans. Kind is `u` (user) or `s` (service account), consistently across space and account endpoints. No display name/email is added. |
| `search.mode` | RPC span: `fulltext`, `semantic`, `hybrid`, or `filter`. |
| `search.requested_limit`, `search.returned_count` | RPC span: requested/default limit and actual returned row count. |
| `search.returned_text_bytes` | RPC span: sum of UTF-8 result-content bytes before JSON escaping/envelope overhead. |

HTTP completion labels use a fixed vocabulary: known RPC/token routes, auth/API
catch-all buckets, or `web`; standard methods or `OTHER`; numeric HTTP status;
`success`, `client_error`, `server_error`, or `exception`. No raw URL, RPC method,
space, principal, API key, query, or result identifier becomes a metric label.
Existing trace URL/identity attributes are unchanged.

Response helpers stringify exactly once and reuse that string for the response.
`Buffer.byteLength` counts UTF-8 bytes without constructing another payload
buffer. A WeakMap stores numeric metadata only, so it does not retain a second
payload or keep a response alive. The measurement does not clone or consume a
response body, add headers, change the response schema, or report per-request
RSS differences as allocation attribution. Search-result byte counting similarly
visits existing strings without serializing them.

Size/serialization measurements cover server JSON response helpers, including
JSON-RPC success/business-error responses. Static files, streamed bodies, and
Better Auth's independently constructed responses are not measured. Existing
OAuth error classification may clone a token response; the new sizing code does
not. Genuine serialization errors are recorded as RPC failures. Expected business
errors remain expected outcomes, not exception noise. HTTP success status is
independent of a JSON-RPC business error (normally HTTP 200).

CLI/MCP field projection is client-side and does not reduce server response size;
see [Field projection](field-projection-and-format-selection.md).

Embedding batch spans and tokenizer accounting are described in
[Embedding queue and worker](embedding-queue-and-worker.md).

## Request rates and memory-operation volume

The same RPC spans support per-space/per-principal request and mutation-volume
queries. Identity comes only from authenticated server context: space RPC uses
`principalId`/`principalKind`; account RPC uses `userId`/`kind` (including service
accounts). Request headers and params cannot supply or overwrite those fields.
Identity remains trace-only, never a per-principal/per-space metric label.

There is one `rpc.<method>` span for each dispatched, schema-valid method call.
`rpc.outcome` is `success`, `business_error`, or `error`. Requests rejected before
dispatch (authentication, method lookup, authorization gates, parameter/envelope
validation) do not have this RPC span; aggregate HTTP counters still cover their
HTTP handlers. Rates below therefore measure dispatched RPCs, not every incoming
attempt. Span timestamp buckets use operation start time; a long operation may
finish/export after its bucket.

Mutation handlers add the following **numeric attributes to that existing span**
after their store transaction resolves; no extra event/span or database query is
needed:

| Attribute | Meaning |
| --- | --- |
| `memory.inserted_count`, `memory.updated_count`, `memory.skipped_count` | Actual store-returned statuses for create/batchCreate, not inferred from requested conflict policy. Single update reports one updated SQL row on success. |
| `memory.deleted_count` | Rows deleted by delete/deleteByPath/deleteTree/deleteOrphansInTree. |
| `memory.copied_count`, `memory.moved_count`, `memory.reverted_count` | Dedicated counts for copy, move, and revert. Copy/revert are not also counted as inserted/updated. |
| `memory.affected_count` | Sum of inserted + updated + deleted + copied + moved + reverted; excludes skipped rows. |
| `memory.dry_run` | Whether this mutation is a preview. |
| `memory.preview_count` | Candidate rows for a dry-run tree operation; actual mutation counts are zero. |

Known mutation outcomes include zero-valued counters, so an all-skipped create
has affected count zero. Read-only operations do not have mutation counts.
Failed/rolled-back writes emit no mutation counts. Counts are recorded before
follow-up reads, so a known committed write can have counts even if its subsequent
read or response serialization fails. Do not discard those counts solely because
`rpc.outcome` is `error`.

These are **operation row outcomes**, not distinct-memory counts, logical version
changes, audit-event counts, or a durable accounting ledger. Repeated operations
on the same memory count repeatedly. A successful `memory.update` counts one SQL
UPDATE row even if its payload is identical and its logical version does not
change; move has the store's corresponding row-count semantics. Revert counts a
successful revert target but does not guess whether the boolean store result was
a live update or an undelete. Physical changes made outside these handlers are
not included. No input text, metadata, paths, memory IDs, or credential values are
added by these summaries. Private server-only context wiring prevents a JSON
request from installing a telemetry callback.

### Requests per minute by space, principal, and operation

Set the Logfire query time window to the period of interest. Omit either identity
from SELECT/GROUP BY to roll up per space or per principal:

```sql
select time_bucket('1 minute', start_timestamp) as t,
       attributes->>'space.slug' as space,
       attributes->>'principal.id' as principal,
       attributes->>'principal.kind' as principal_kind,
       attributes->>'rpc.method' as operation,
       attributes->>'rpc.outcome' as outcome,
       count(*) as requests_per_minute
from records
where service_name = 'memory-engine'
  and deployment_environment = 'aws-prod'
  and span_name like 'rpc.memory.%'
group by time_bucket('1 minute', start_timestamp),
         attributes->>'space.slug', attributes->>'principal.id',
         attributes->>'principal.kind', attributes->>'rpc.method',
         attributes->>'rpc.outcome'
order by t desc
limit 50
```

### Affected and skipped memories per minute

This is separate from request rate: one batchCreate request might insert 100
memories. Do not add preview counts to affected counts. Add individual mutation
counters to the query to break the volume down by outcome:

```sql
select time_bucket('1 minute', start_timestamp) as t,
       attributes->>'space.slug' as space,
       attributes->>'principal.id' as principal,
       attributes->>'rpc.method' as operation,
       sum((attributes->>'memory.affected_count')::bigint) as affected_memories,
       sum((attributes->>'memory.skipped_count')::bigint) as skipped_memories,
       count(*) as mutation_requests
from records
where service_name = 'memory-engine'
  and deployment_environment = 'aws-prod'
  and span_name like 'rpc.memory.%'
  and attributes->>'memory.affected_count' is not null
group by time_bucket('1 minute', start_timestamp),
         attributes->>'space.slug', attributes->>'principal.id',
         attributes->>'rpc.method'
order by t desc
limit 50
```

No per-tenant/principal dashboard or alert definition is provisioned by this
change. Trace sampling, exporter failures, abrupt kills, and partial time buckets
can undercount these operational rates. They are not suitable for exact billing;
use database-backed audit/history records for durable accounting.

## Investigating a restart in Logfire

Group memory time series by `service_instance_id` and environment before comparing
replicas. Example metric query (select an appropriate Logfire query time window):

```sql
select time_bucket('1 minute', recorded_timestamp) as t,
       service_instance_id, metric_name,
       max(metric_max(value)) as peak
from metrics
where service_name = 'memory-engine'
  and deployment_environment = 'aws-prod'
  and metric_name in (
    'memory_engine.process.memory.rss',
    'memory_engine.process.memory.heap_used',
    'memory_engine.cgroup.memory.usage',
    'memory_engine.cgroup.memory.limit'
  )
group by time_bucket('1 minute', recorded_timestamp),
         service_instance_id, metric_name
order by t desc
limit 50
```

Then inspect the expensive search spans for the same process/time window:

```sql
select start_timestamp, service_instance_id, trace_id,
       attributes->>'space.slug' as space,
       attributes->>'search.mode' as mode,
       attributes->>'search.requested_limit' as requested_limit,
       attributes->>'search.returned_count' as returned_count,
       attributes->>'search.returned_text_bytes' as text_bytes,
       attributes->>'http.response.body.size' as response_bytes
from records
where deployment_environment = 'aws-prod'
  and span_name = 'rpc.memory.search'
order by (attributes->>'http.response.body.size')::float desc nulls last
limit 50
```

Compare sustained growth versus isolated spikes, JS heap versus RSS, response
sizes versus request concurrency, and tokenizer queued bytes versus active work.
These are correlations, not proof that a particular request allocated retained
memory. Histograms aggregate completed helper calls; abrupt kills can lose spans
for the very operation that caused a spike.

## What the application cannot guarantee

An OOM SIGKILL cannot be caught. Application sampling cannot reliably confirm the
victim's own OOM kill because it may never emit/flush another sample, and a new
container may get fresh cgroup counters. A one-second final flush is best effort
for graceful shutdown, not an OOM handler. Logfire's existing SIGTERM SDK shutdown
listener can also race a post-drain flush.

Kubernetes/container monitoring outside the application is still required for
restart count, last termination reason (`OOMKilled`), and uninterrupted container
usage/limit telemetry. Configure an external OpenTelemetry Collector/Kubernetes
monitoring integration to send those signals to Logfire. No collector or cluster
configuration is installed by this change.
