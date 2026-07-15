# Getting Started

Memory Engine is permanent memory for AI agents. Store, search, and organize knowledge that persists across conversations.

> **Were you invited to a shared space?** Head to [Joining a Space](joining-a-space.md) for a
> teammate-focused walkthrough — logging in, selecting the space, and searching what's
> already there.

## Install

```bash
curl -fsSL https://install.memory.build | sh
```

This installs the `me` binary to `~/.local/bin`. Make sure it's on your PATH.

## Sign up and log in

```bash
me login
```

This opens your browser to sign in via GitHub or Google (an OAuth 2.1 auth-code + PKCE flow over a `127.0.0.1` loopback redirect) and stores your credentials. On a host with a system keychain they're stored there; otherwise they fall back to `~/.config/me/credentials.yaml` (mode 0600).

On a **headless** host with no local browser (an agent harness in a sandbox, a remote SSH session, a container), use `me login --device` instead: the CLI prints a short URL and code to approve on any device (the OAuth 2.0 device authorization grant), yielding a rolling 7-day session token. See [`me login`](cli/me-login.md).

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
# Hybrid search (meaning + keywords)
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

For a richer, visual experience there's a web UI with a tree explorer, hybrid / advanced search, a rendered Markdown viewer, and an editor for content + metadata.

- **Hosted (no install):** open [**api.memory.build**](https://api.memory.build/) and sign in with GitHub or Google — the same account you'd use for `me login`. This is the quickest way in if you don't want to touch the CLI.
- **Local:** run `me serve` to start the same UI against your CLI session on `http://127.0.0.1:3000` (or the next free port). See [`me serve`](cli/me-serve.md).

## Connect to AI tools

Register Memory Engine with your AI coding tools:

```bash
me opencode install
me codex install
me gemini install
```

For a guided, per-project setup that goes further than `install` — choosing a shared or private project tree, backfilling existing sessions, enabling automatic capture going forward, and adding a memory pointer to `CLAUDE.md`/`AGENTS.md` — run [`me project init`](cli/me-project.md) once per project. It's harness-agnostic: it detects whichever of Claude Code/OpenCode/Codex you actually have installed and have sessions for, and only offers the steps that apply:

```bash
me project init              # guided per-project setup
```

For Claude Code, `me claude install` installs the one user-scoped Memory Engine plugin (hooks + slash commands + MCP) — run it once, it applies to every project:

```bash
me claude install            # full plugin (once, user scope)
me claude install --mcp-only # or just the MCP server
```

This drives Claude Code's native plugin flow for you (`claude plugin marketplace add` + `claude plugin install`), then persists your resolved server + active space as global defaults and **asks whether to capture your Claude Code sessions as memories**. Capture is **off by default**; opt in and new sessions (plus a one-time backfill of your existing ones) are captured **privately** under `~/projects/<repo>` — sharing with a team is a separate, per-project choice via [Projects](projects.md) and [`.me/config.yaml`](project-config.md). Afterwards, restart Claude Code (or run `/plugin`) to load the hooks and slash commands; re-run `/plugin` → `memory-engine` → Configure to adjust options, or re-run `me claude install` to change the capture answer.

After installation, your AI agent has access to memory tools -- create, search, get, update, delete, and more.

See [MCP Integration](mcp-integration.md) for details.

## What's next

- [Core Concepts](concepts.md) -- understand memories, tree paths, metadata, search modes
- [Projects](projects.md) -- set up repository memory trees and project grants
- [Access Control](access-control.md) -- spaces, principals, and tree-access grants
- [Memory Packs](memory-packs.md) -- install pre-built knowledge collections
- [MCP Integration](mcp-integration.md) -- how AI agents use Memory Engine
- [CLI Reference](cli/me-memory.md) -- full command reference
- [MCP Tool Reference](mcp/index.md) -- full MCP tool reference
