# me serve

Run a local web UI for viewing and managing memories.

## Usage

```
me serve [--port <port>] [--host <host>] [--no-open]
```

## Description

Starts a local HTTP server that:

- Serves a React-based UI for browsing, searching, viewing, editing, and deleting memories.
- Proxies JSON-RPC calls from the browser to the configured engine, injecting your stored API key so the key never leaves the machine.

By default the server binds to `127.0.0.1:3000`; if 3000 is busy it tries 3001, 3002, … up to 3019 before giving up. Passing `--port` explicitly is strict — it does not auto-increment.

The browser opens automatically on startup unless `--no-open` is passed. Press `Ctrl+C` to stop.

The UI talks to whichever engine is active for the current server — same resolution as every other `me` command (`--server` flag > `ME_SERVER` env > stored `default_server`; within the server, the active engine is picked via `me engine use`). Run `me whoami` to confirm.

## Options

| Option | Description |
|--------|-------------|
| `--port <port>` | Port to bind. Default `3000`, auto-incrementing only when the default is busy. |
| `--host <host>` | Host to bind. Default `127.0.0.1` (loopback only). |
| `--no-open` | Do not auto-open the browser after the server starts. |

## Global Options

| Option | Description |
|--------|-------------|
| `--server <url>` | Server URL (overrides `ME_SERVER` env and stored default) |
| `--json` | Output the startup banner as JSON instead of text |
| `--yaml` | Output the startup banner as YAML instead of text |

## UI overview

```
┌───────────────────────────────────────────────────────────────┐
│  Search  [Simple | Advanced]  [Clear]                         │
├────────────────────┬──────────────────────────────────────────┤
│                    │  tree breadcrumb [Copy] [Edit] …         │
│   TreeView         │                                          │
│    . (root)        │   rendered markdown / Monaco editor      │
│      ├── work      │                                          │
│      │    └── 📄 … │                                          │
│      └── personal  ├──────────────────────────────────────────┤
│                    │  id, embedding, timestamps (read-only)   │
└────────────────────┴──────────────────────────────────────────┘
```

- **Tree** (left): ltree paths as collapsible nodes, memories as leaves. Right-click a node for a context menu (delete memory / delete subtree).
- **Search** (top): simple hybrid search by default; flip to Advanced for every field accepted by `memory.search` (semantic, fulltext, grep, tree, meta, temporal, limit, candidateLimit, weights, orderBy).
- **Viewer / Editor** (right): rendered Markdown with syntax highlighting, or the Monaco editor with YAML frontmatter + body. The copy button copies the Markdown source with frontmatter. Save is disabled until you make a valid change. The read-only metadata panel sits below.
- **URL state**: filter fields and the selected memory id are reflected in the URL, so any view can be shared or bookmarked.

## Security notes

- The server binds to `127.0.0.1` only — no LAN exposure. The browser never sees your API key or session token; `me serve` injects them into RPC calls on the way out.
- No authentication is required on the local server. Do not `--host 0.0.0.0` or tunnel the port unless you understand the implications.

## Examples

```bash
# Simplest invocation — picks a port, opens the browser.
me serve

# Use a specific port and skip auto-open (handy when iterating in dev).
me serve --port 8080 --no-open

# Point at a specific engine server.
me serve --server https://api.memory.build
```

## See also

- [`me engine use`](me-engine.md) — pick the active engine that `me serve` will connect to.
- [`me memory search`](me-memory.md#search) — the CLI equivalent of the UI's search bar.
