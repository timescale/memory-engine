---
title: Runtime and OOM Observability
tags: [server, telemetry, logfire, operations]
---

# Runtime and OOM Observability

The API and standalone embedding-worker entrypoints share process telemetry
setup in `packages/server/telemetry.ts`. Both configure Logfire and start a
process-wide memory sampler before application bootstrap (including API database
migrations), keeping sampling active until application drain completes. API
processes use service name `memory-engine`; standalone consumers use
`memory-engine-worker`. Both retain the same resource identity, scrubbing,
fail-open setup, telemetry profile, and bounded SDK shutdown behavior.
`startServer()` and `startEmbeddingWorkers()` remain free of process-global
telemetry configuration so in-process harnesses do not install extra timers or
change global providers. The shared process lifecycle also finalizes telemetry
on startup failure and fatal worker-loop failure.

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
and semantic conventions 1.43.0. Diagnostic runtime gauges and HTTP instruments
use the SDK's existing metrics provider and reader. Tests check installed peer
ranges and identical resolved module paths across database/embedding/engine/server/worker.

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

## Telemetry profiles and runtime measurements

`LOGFIRE_TELEMETRY_PROFILE=lean` is the default for both API and standalone
workers. Unknown profile values fail lean rather than enabling metrics. This is
a trace-first application profile: RPC spans, search/response sizes, authenticated
principal identity, and mutation attributes are unchanged. Kubernetes monitoring
in `timescale/tiger-agents-deploy`, under `charts/memory-engine`, owns working
set, memory limits, container RSS/CPU, restarts, and OOM alerts for API and worker
containers. Logfire carries sparse application state to correlate with those
Prometheus signals by pod, environment, and time.

The ingest investigation motivating this split observed metric ingest increase
from 2,120/hour to 233,633/hour across dev and prod combined. Automatic runtime-node
V8 metrics (52 series) accounted for 61.5% of ingest; 48 zero-valued series
accounted for 56.8%. These are observations from that investigation, not a
prediction of future volume or cost.

| Behavior | `lean` (default) | `diagnostic` (incident opt-in) |
| --- | --- | --- |
| SDK metrics | Disabled; no exported HTTP or snapshot metric points | Application HTTP instruments and nine snapshot gauges enabled |
| `Runtime memory sample` structured log | Startup, then every 60,000 ms | Startup, then every 10,000 ms |
| SDK metric export | No metric reader/export | SDK-native 60-second reader |
| Automatic runtime-node / V8 instrumentation | Disabled | Disabled |
| Cgroup filesystem sampling or metrics | None | None |
| Provider-wide periodic `forceFlush()` | None | None |

Each sample is a single `Runtime memory sample` event with numeric-only snapshot
attributes in `packages/server/runtime-telemetry.ts`. Resource identity (service,
environment, pod, and process instance) is retained separately. There is no input
text, per-job identifier, heap snapshot, or new payload retention. Unavailable,
non-finite, or negative measurements are omitted, not fabricated as zero.

| Sample attribute | Diagnostic gauge | Unit / interpretation |
| --- | --- | --- |
| `rss` | `memory_engine.process.memory.rss` | Bytes resident for this process. |
| `heapUsed` | `memory_engine.process.memory.heap_used` | Bytes reported by Bun's `process.memoryUsage().heapUsed`. |
| `external` | `memory_engine.process.memory.external` | Runtime-reported external bytes. |
| `uptime` | `memory_engine.process.uptime` | Seconds since process startup. |
| `tokenizerThreads` | `memory_engine.tokenizer.threads` | Managed worker slots, not configured maximum or total OS threads. |
| `tokenizerActiveJobs` | `memory_engine.tokenizer.active_jobs` | Jobs dispatched and awaiting a result. |
| `tokenizerQueuedJobs` | `memory_engine.tokenizer.queued_jobs` | Jobs waiting for a worker. |
| `tokenizerActiveInputBytes` | `memory_engine.tokenizer.active_input` | UTF-8 input bytes belonging to active jobs. |
| `tokenizerQueuedInputBytes` | `memory_engine.tokenizer.queued_input` | UTF-8 input bytes belonging to waiting jobs. |

The diagnostic gauges have no point labels. Heap-total, ArrayBuffer, and cgroup
measurements are not part of either profile. Bun's JS memory categories are
runtime-reported diagnostics, not V8 heap statistics. Process RSS, JS heap, and
external memory are not necessarily disjoint: do not sum them or label their
difference a proven leak. Worker dictionaries/native allocations can raise RSS
without raising main-thread JS heap usage. Container RSS and working set cover
different scopes and semantics from JS heap; they cannot be directly compared
as equivalent measurements or subtracted to attribute allocations.

### Sampling, export, and shutdown

`LOGFIRE_RUNTIME_SAMPLE_INTERVAL_MS` overrides the structured-log sampling
interval in either profile, with a minimum of 10,000 ms. Positive safe integers
up to 2,147,483,647 ms are accepted; smaller positive values are clamped to the
minimum. Invalid, nonpositive, unsafe, or out-of-timer-range values fall back to
the profile default (60,000 ms lean; 10,000 ms diagnostic). The timer is unref'd.
This setting does not change diagnostic metric export cadence. Profile and
interval settings are read at process startup: changing production configuration
requires restart/redeploy, not a new image release once profile support is
available. Explicitly restore lean and remove temporary interval overrides after
an incident; see the operational recipe in `DEVELOPMENT.md`.

`OTEL_METRIC_EXPORT_INTERVAL` no longer controls this application. Diagnostic
metrics use the SDK's native 60-second reader. There is no sampling-tick or other
provider-wide periodic `forceFlush()` of metrics, spans, or logs; normal SDK
batching remains responsible for export.

Lean configures SDK metrics off and suppresses implicit NodeSDK metric exporters,
so disabling explicit metrics cannot accidentally create a localhost OTLP metrics
pipeline. `OTEL_METRICS_EXPORTER` is intentionally set to `none` even if inherited
from the deployment: the application profile, not an implicit OTel exporter,
controls metric opt-in. Implicit no-token log exporters are also suppressed. Diagnostic uses
the SDK's existing provider and reader, not a second metrics pipeline.

Boot failure, fatal worker-loop failure, and graceful shutdown still finalize
telemetry with bounded public SDK shutdown (`shutdown({ timeoutMillis: 1000 })`),
including SIGINT/explicit exit where `beforeExit` is not emitted. There is no
special periodic flush or OOM handler. Samples and spans may be sampled, buffered,
dropped, or lost to network failure or SIGKILL; even graceful shutdown's final
export is best effort. Lean normally schedules roughly one small sample event
per minute per process, not a guarantee of one ingested observation per minute.

## HTTP and RPC measurements

HTTP metric instruments remain in the application but export points only in the
`diagnostic` profile. Span attributes below remain available in both profiles.
Routine `Health check` info and `space auth succeeded` debug logs are removed;
failure logs are preserved. Health/readiness HTTP request spans remain traced:
removing success logs does not exclude probes from tracing.

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
validation) do not have this RPC span; HTTP spans still cover their handlers,
and aggregate HTTP counters cover them when diagnostic metrics are enabled.
Rates below therefore measure dispatched RPCs, not every incoming attempt. Span timestamp buckets use operation start time; a long operation may
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

## Investigating a restart across Prometheus and Logfire

Start with Prometheus/Kubernetes monitoring for the affected API or worker pod:
check working set versus its memory limit, container RSS/CPU, restart count, and
OOM/termination evidence. Select that environment and time window in Logfire,
match the pod resource identity, then distinguish process lifetimes with
`service_instance_id`. Do not join replicas or successive lifetimes merely by
service name. Example application-state query (works in lean without metrics;
use `memory-engine-worker` for standalone workers):

```sql
select start_timestamp, service_instance_id,
       attributes->>'rss' as process_rss_bytes,
       attributes->>'heapUsed' as heap_used_bytes,
       attributes->>'external' as external_bytes,
       attributes->>'uptime' as uptime_seconds,
       attributes->>'tokenizerActiveJobs' as tokenizer_active_jobs,
       attributes->>'tokenizerQueuedJobs' as tokenizer_queued_jobs,
       attributes->>'tokenizerQueuedInputBytes' as tokenizer_queued_input_bytes
from records
where service_name = 'memory-engine'
  and deployment_environment = 'aws-prod'
  and message = 'Runtime memory sample'
order by start_timestamp desc
limit 50
```

Filter to the matching instance when inspecting expensive search spans for that
process/time window:

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

Correlate sustained process RSS/heap trends, response sizes and concurrent request
spans, and tokenizer queued bytes versus active work with the pod's Prometheus
timeline. Sparse samples can miss short spikes; container RSS is not JS heap.
These are correlations, not proof that a particular request allocated retained
memory. Diagnostic histograms aggregate completed helper calls; abrupt kills can
lose spans for the very operation that caused a spike. Removed Logfire cgroup
metrics cannot supply container limits, utilization, or OOM counters in either
profile; use the infrastructure monitoring source instead.

## What the application cannot guarantee

An OOM SIGKILL cannot be caught. Application sampling cannot reliably confirm the
victim's own OOM kill because it may never emit/export another sample. Bounded
SDK shutdown is best effort for graceful termination, not protection against OOM.

Kubernetes/container monitoring in `timescale/tiger-agents-deploy`'s
`charts/memory-engine` provides infrastructure signals and OOM alerts for both
roles independently of the application's Logfire exporter. Those Prometheus
signals do not need to be duplicated as application cgroup metrics in Logfire.
Missing application samples do not establish healthy memory usage or absence of
an OOM. Neither profile is a durable accounting or uninterrupted monitoring feed.
