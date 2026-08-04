# Field Projection and Format Selection

**Linear:** TNT-206, TNT-257

## Decision

Implement field projection at the CLI and MCP presentation boundaries, after
the TypeScript client has received a complete JSON-RPC response.

Do not add `select` to the JSON-RPC protocol, server handlers, or general
TypeScript client. `memory.get`, `memory.getByPath`, and `memory.search` retain
their existing inputs and exact full response types.

`format` is also a presentation concern for MCP and CLI. It is not an RPC or
general client parameter.

## Rationale

The product benefit is reducing MCP context consumption and making CLI output
easier to scan. Both are achieved as long as projection happens before MCP text
serialization or CLI rendering; the model and terminal do not observe the full
internal RPC response.

Server-side projection would make each affected RPC polymorphic: calls without
`select` return a complete memory, while calls with `select` return a partial
object. That polymorphism leaks into the TypeScript SDK. Optional or dynamic
`select` values cannot safely preserve a strict full-response return type, and
correct overloads require mutually exclusive parameter types plus a union for
dynamic selection. This complexity is not justified for a presentation feature.

Keeping projection out of JSON-RPC provides stronger contracts by construction:

- RPC and SDK callers always receive the existing complete response.
- Omitted selection cannot alter response behavior.
- CLI and MCP own the partial presentation shapes they expose.
- Server, engine, and database code remain unchanged.
- No projected response schemas or SDK overloads are needed.

The tradeoff is that complete content and metadata travel from the server to the
CLI or MCP process before projection. The database query already retrieves the
complete memory, and there is no evidence that this additional transfer is a
bottleneck. If profiling later demonstrates otherwise, server-side projection
can be designed as a deliberate public API rather than leaking presentation
concerns into the existing methods.

## Presentation API

Add selection only to these user-facing presentation surfaces:

- MCP `me_memory_get`, `me_memory_get_by_path`, and `me_memory_search` accept an
  optional, nonempty `select` list.
- CLI `me memory get` and `me memory search` accept `--select <csv>`.
- Default CLI text search locally projects ID, tree, a 120-code-unit content
  preview, and score.

An omitted selection presents the complete response. An empty selection is
invalid.

Selectors use the camelCase names of the already-shaped client response:

| Selector | Result |
| --- | --- |
| `id` | Memory UUID |
| `content` | Full content |
| `content:N` | First `N` content code units and `contentLength` |
| `content:M:N` | Content slice `[M, N)` and `contentLength` |
| `content:M:` | Content from `M` through the end and `contentLength` |
| `meta` | Full metadata object |
| `meta.key` | Requested metadata key within `meta` |
| `tree` | Display tree path |
| `name` | Optional memory name |
| `temporal` | Temporal range |
| `score` | Search relevance score; omitted on get operations |
| `hasEmbedding` | Whether an embedding exists |
| `createdAt` | Creation timestamp |
| `createdBy` | Memory creator (currently always `null`) |
| `updatedAt` | Last-update timestamp |
| `version` | Memory version |
| `versionHash` | Memory version hash |

### Metadata keys

Metadata accepts arbitrary string keys. A `meta.` selector therefore preserves
the complete nonempty suffix as the key, including built-in keys such as
`$thread`, `$prev`, and `$next`, and keys containing punctuation. Multiple
metadata-key selectors combine into one `meta` object. A missing key is absent
from that object. The bare `meta` selector takes precedence and returns all
metadata.

### Content slices

Use zero-based, end-exclusive JavaScript slice semantics:

```text
content:200       # [0, 200)
content:100:300   # [100, 300)
content:100:      # [100, end)
```

Bounds are non-negative safe integers. `contentLength` is the total JavaScript
string length, measured in UTF-16 code units. Negative indexes are deliberately
not part of this initial API.

When `content` and one slice selector are both requested, the slice takes
precedence. Reject multiple distinct content-slice selectors rather than making
array order affect the result. Exact duplicate selectors are harmless.

## Format Selection

MCP get, get-by-path, and search accept presentation-only `format`:

- `yaml` is the default.
- `json` and `compact` both produce compact JSON.

MCP optional inputs follow the existing tool convention: they may be omitted or
passed as `null`. CLI keeps the existing global `--json` and `--yaml` behavior.

## Implementation

1. Add a shared CLI projection module used by both command and MCP code. It owns
   selector validation, parsing, and the pure projection helper.
2. Keep projection types local to the CLI package. They describe presentation
   output, not JSON-RPC responses.
3. MCP validates `select` and `format`, fetches a complete response through the
   existing client, projects locally when requested, then serializes it.
4. CLI get/search fetch complete responses through the existing client and
   project locally before rendering. Default text search uses the same helper
   for its preview fields.
5. Do not change `packages/protocol`, `packages/server`, `packages/engine`,
   `packages/database`, or public client method signatures for projection.
6. Update CLI and MCP documentation only; the TypeScript client API remains
   unchanged.

## Tests

- Shared projection unit tests: every bare selector, arbitrary metadata keys,
  missing metadata keys, duplicate selectors, conflicting content slices,
  non-negative safe-integer bounds, content precedence, UTF-16 lengths, and
  score omission for get responses.
- CLI command tests: ID and path get, explicit `--select`, default text-search
  projection, previews and ellipses, every score value, and JSON/YAML behavior.
- MCP tool tests: select forwarding to the local projector, omitted and `null`
  options, empty-selection rejection, full output when omitted, YAML default,
  and compact `json`/`compact` output.
- Client regression tests should continue to assert full response types and
  unchanged request payloads; no projection overload tests are needed.
- Run `./bun run check` and `./bun run check:full`.

## Deferred Optimization

If profiling shows that transferring complete content or metadata from the
server is costly, add a separately reviewed server/API optimization. Preserve
strict SDK typing, potentially through explicit projected methods rather than
an optional parameter that changes the return shape. Do not introduce that
complexity preemptively.
