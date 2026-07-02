# Getting Started

Memory Engine is permanent memory for AI agents. Store, search, and organize knowledge that persists across conversations.

## Install

```bash
curl -fsSL https://install.memory.build | sh
```

This installs the `me` binary to `~/.local/bin`. Make sure it's on your PATH.

## Sign up and log in

```bash
me login
```

This starts an OAuth device flow via GitHub or Google -- authorize in your browser and the CLI stores your session token (rolling 7-day, refreshed as you use it). On a host with a system keychain the token is stored there; otherwise it falls back to `~/.config/me/credentials.yaml` (mode 0600).

If you belong to more than one space, pick the active one (it's carried as the `X-Me-Space` on every request):

```bash
me space list
me space use <slug-or-name>
```

`me login <space>` selects it in one step, and `me whoami` shows your identity and active space.

If your CLI is older than the server (or vice versa), `me login` will tell you and bail out before sending you to the browser. You can run the same check explicitly:

```bash
me version
```


## Store your first memory

```bash
me memory create "PostgreSQL 18 supports native UUIDv7 generation." \
  --tree share/notes/postgres \
  --name uuidv7 \
  --meta '{"topic": "database"}'
```

A `--tree` is required. Put memories the rest of your space should see under `share/*`, and personal ones under `~/*` (your private home). The optional `--name` gives the memory a filename-like slug (unique within its tree) so you can later address it by path -- `me get share/notes/postgres/uuidv7`. See [Core Concepts](concepts.md#reserved-roots).

## Search

```bash
# Hybrid search (recommended default: meaning + keywords)
me memory search "UUID generation in Postgres"

# Keyword search
me memory search --fulltext "UUIDv7"

# Pure semantic search (by meaning only)
me memory search --semantic "database-generated identifiers"
```

## Browse the tree

```bash
me memory tree
```

## Browse in the web UI

For a richer, visual experience:

```bash
me serve
```

Starts a local web UI on `http://127.0.0.1:3000` (or the next free port) with a tree explorer, hybrid / advanced search, rendered Markdown viewer, and a Monaco-based editor for content + metadata. See [`me serve`](cli/me-serve.md) for details.

## Connect to AI tools

Register Memory Engine with your AI coding tools. Each has two commands:

**`me <tool> install`** — set it up **for your user** (global). MCP tools,
session capture, the `memory-engine` skill, and a `/memory-recall` command, all
running as **you** (your `me login` session):

```bash
me claude install
me opencode install
me codex install
me gemini install
```

**`me <tool> init`** — set up **this project** (committable config in the repo).
It backfills existing sessions + git history, installs ongoing capture + a git
post-commit hook, and adds a memory pointer to the tool's context file. Memory
access runs as the **project's agent** (the `agent` in `.me/config.yaml`) — so
the harness acts as a constrained agent that belongs to you, not as you:

```bash
me claude init      # or: me opencode init / me codex init / me gemini init
```

`init` requires a `.me/config.yaml` with an `agent:` (see
[Project config](project-config.md#the-agent-field-act-as-agent)).

After installation, your AI agent has access to memory tools -- create, search, get, update, delete, and more.

See [MCP Integration](mcp-integration.md) for details.

## What's next

- [Core Concepts](concepts.md) -- understand memories, tree paths, metadata, search modes
- [Access Control](access-control.md) -- spaces, principals, and tree-access grants
- [Memory Packs](memory-packs.md) -- install pre-built knowledge collections
- [MCP Integration](mcp-integration.md) -- how AI agents use Memory Engine
- [CLI Reference](cli/me-memory.md) -- full command reference
- [MCP Tool Reference](mcp/me_memory_search.md) -- full MCP tool reference
