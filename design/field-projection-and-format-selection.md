---
title: Field Projection and Format Selection
tags: [cli, mcp, presentation, memory]
---

# Field Projection and Format Selection

`select` and MCP `format` control how memory reads are presented by the CLI and
MCP server. They are not part of the memory data API.

## Motivation

Memory search is commonly a discovery step: agents first identify the few
memories relevant to a task, then retrieve their complete content. Returning
every full memory while searching can consume enough context to crowd out the
work the agent is trying to do.

Use `select` to return a compact search result with identifying fields and a
content preview, then retrieve the selected memory in full with `get` or
`getByPath`. This reduces model-context consumption without changing search
semantics or withholding data from callers that need complete records.

## Boundary

The TypeScript client calls the existing `memory.get`, `memory.getByPath`, and
`memory.search` RPC methods and receives complete responses. The CLI and MCP
server project those responses locally, immediately before terminal rendering or
MCP serialization.

The JSON-RPC protocol, server handlers, engine, database functions, and general
TypeScript client do not accept `select` or `format` parameters. Projection does
not reduce data transferred from the server, change authorization, or change how
search results are formed. A server-side projection API requires a separate
design because it would make otherwise full, strongly typed client responses
partial.

## Selectors

CLI `memory get` and `memory search` accept a comma-separated `--select` value.
MCP accepts a `select` array on `me_memory_get`, `me_memory_get_by_path`, and
`me_memory_search`. A selection must contain at least one valid selector.

The available response fields are:

```text
id, content, meta, tree, name, temporal, score, hasEmbedding,
createdAt, createdBy, updatedAt, version, versionHash
```

Metadata selectors use `meta.<key>`. The suffix is any nonempty metadata key,
including keys containing punctuation or `$`. Missing metadata keys are omitted
from the projection.

Content may be selected in full or sliced with zero-based, end-exclusive bounds:

```text
content:N       # [0, N)
content:M:N     # [M, N)
content:M:      # [M, end)
```

Slice bounds must be non-negative JavaScript safe integers. Slices use
JavaScript string indexing, so `contentLength` and offsets are measured in
UTF-16 code units. A slice adds `contentLength` to the response. At most one
distinct slice selector is permitted; duplicate instances of the same selector
are allowed.

When selectors overlap, a content slice takes precedence over full `content`,
and bare `meta` takes precedence over individual `meta.<key>` selectors. The
projected field order is fixed by the presentation implementation, not by the
selector order.

`score` is a valid selector for every read tool, but get responses have no score
field and therefore omit it. Search projections retain the `results`, `total`,
and `limit` envelope while projecting each result row.

## Formats

MCP supports a presentation-only `format` argument on its three retrieval and
search tools. It defaults to `yaml`; `json` and `compact` both produce compact
one-line JSON.

CLI does not have a per-command format option. Its existing global `--json` and
`--yaml` options control structured output; otherwise commands render text.
`memory get --raw` cannot be combined with `--select`.

Without an explicit `--select`, CLI text search still fetches complete results
but locally presents `id`, `tree`, `content:120`, and `score`. Structured CLI
output and MCP calls without `select` present complete responses.

## Constraints

- Selector validation and projection remain shared CLI-package behavior so CLI
  and MCP output stays consistent.
- MCP retrieval/search tools validate `select` before rendering and accept
  omitted or `null` presentation options as the default full YAML response.
- Presentation options stay limited to the three retrieval/search MCP tools;
  they are not generic options for every read tool.
