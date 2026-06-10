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
  --tree share.notes.postgres \
  --meta '{"topic": "database"}'
```

A `--tree` is required. Put memories the rest of your space should see under `share.*`, and personal ones under `~.*` (your private home). See [Core Concepts](concepts.md#reserved-roots).

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

Register Memory Engine with your AI coding tools:

```bash
me opencode install
me codex install
me gemini install
```

For Claude Code, `me claude install` installs the full Memory Engine plugin (hooks + slash commands + MCP):

```bash
me claude install            # full plugin
me claude install --mcp-only # or just the MCP server
```

This drives Claude Code's native plugin flow for you (`claude plugin marketplace add` + `claude plugin install`), passing your resolved server/space/api_key through `--config`. Afterwards, restart Claude Code (or run `/plugin`) to load the hooks and slash commands; you can re-run `/plugin` → `memory-engine` → Configure to adjust options. All are optional except `server`: leave `api_key` blank to use your `me login` session, leave `space` blank to use your active space, and `tree_root` defaults to `share.projects`.

After installation, your AI agent has access to memory tools -- create, search, get, update, delete, and more.

See [MCP Integration](mcp-integration.md) for details.

## What's next

- [Core Concepts](concepts.md) -- understand memories, tree paths, metadata, search modes
- [Access Control](access-control.md) -- spaces, principals, and tree-access grants
- [Memory Packs](memory-packs.md) -- install pre-built knowledge collections
- [MCP Integration](mcp-integration.md) -- how AI agents use Memory Engine
- [CLI Reference](cli/me-memory.md) -- full command reference
- [MCP Tool Reference](mcp/me_memory_search.md) -- full MCP tool reference
