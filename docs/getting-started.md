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

If you belong to more than one space, pick the active one:

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
  --tree /share/notes/postgres \
  --name uuidv7 \
  --meta '{"topic": "database"}'
```

A `--tree` is required. Put memories the rest of your space should see under `/share/*`, and personal ones under `~/*` (your private home). The optional `--name` gives the memory a filename-like slug (unique within its tree) so you can later address it by path -- `me get share/notes/postgres/uuidv7`. See [Core Concepts](concepts.md#reserved-roots).

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

From a repository you want to configure, run:

```bash
me init
```

This is the recommended coding-agent setup. It signs you in when needed,
selects a space, enables MCP tools and `me` command routing for detected
harnesses, and offers to install missing integrations. It also asks whether to
enable session capture.

Capture is off by default. When enabled, its suggested tree is
`/share/projects/<repository>` for team knowledge; choose
`~/projects/<repository>` instead for private captures.

Verify the result with:

```bash
me doctor
```

Use `me init --verbose` to configure MCP, capture, and CLI routing separately.
For headless or unattended environments, use `me login --device` or supply an
API key through `ME_API_KEY`.

Read [Harness Integrations](harness-integrations.md) for installation,
uninstallation, and machine-local policy details. See [MCP Integration](mcp-integration.md)
for manual MCP client configuration.

## What's next

- [Core Concepts](concepts.md) -- understand memories, tree paths, metadata, search modes
- [Harness Integrations](harness-integrations.md) -- install coding-agent integrations and configure local policy
- [Projects](projects.md) -- set up repository memory trees and project grants
- [Access Control](access-control.md) -- spaces, principals, and tree-access grants
- [Memory Packs](memory-packs.md) -- install pre-built knowledge collections
- [MCP Integration](mcp-integration.md) -- how AI agents use Memory Engine
- [CLI Reference](cli/me-memory.md) -- full command reference
- [MCP Tool Reference](mcp/index.md) -- full MCP tool reference
