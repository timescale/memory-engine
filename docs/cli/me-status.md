# me status

Show the server, active space, and embedding backlog.

## Usage

```
me status
```

## Description

A quick health check for your active space. It prints the server you're talking
to, your active space, and the state of the **embedding queue** — the background
work that makes new memories semantically searchable.

When you create memories (especially after a large [`me import`](me-import.md)),
they're saved and keyword-searchable immediately, but their vector embeddings are
computed asynchronously. Until a memory is embedded, it won't appear in semantic
search. `me status` shows how much of that work is still pending, so you can watch
the backlog drain.

```
me status
  Server: https://api.memory.build
  Space:  6nnv8r3gz9jr
  Embedding queue:
    Pending:   128
    In flight: 4
    Waiting:   0
    Failed:    0
  Oldest pending queued 2m ago.
```

| Field | Meaning |
|-------|---------|
| `Pending` | Memories waiting for an embedding. |
| `In flight` | Embeddings currently being computed. |
| `Waiting` | Items delayed before a retry. |
| `Failed` | Memories whose embedding failed after all retries (still fully usable for keyword and filter search). |

When nothing is pending, it prints `All caught up — no embeddings pending.`

Requires that you are logged in and have an active space. See [`me whoami`](me-whoami.md)
to confirm both.

## Global Options

| Option | Description |
|--------|-------------|
| `--server <url>` | Server URL (overrides `ME_SERVER` env and stored default) |
| `--json` | Output as JSON |
| `--yaml` | Output as YAML |

## See also

- [`me whoami`](me-whoami.md) -- show your identity and active space.
- [Core Concepts → Embeddings](../concepts.md#embeddings) -- why embeddings are asynchronous.
