# MCP Integration

Memory Engine integrates with AI coding agents via the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). This gives agents 15 memory tools they can use to store and retrieve knowledge across conversations.

## How it works

When an AI tool launches `me mcp`, it spawns a child process that communicates over **stdin/stdout** using the MCP protocol. The process is a stateless proxy — each tool call is translated into an HTTP request to the Memory Engine API. No data is stored locally.

```
┌──────────────┐   stdio (JSON-RPC)   ┌──────────┐   HTTPS   ┌────────────────┐
│   AI Agent   │ ◄──────────────────► │  me mcp  │ ────────► │ Memory Engine  │
└──────────────┘                      └──────────┘           └────────────────┘
```

The AI agent never sees or handles credentials — it just calls MCP tools and gets results back.

Each `me mcp` instance uses one of two space modes. An explicit `--space` or `ME_SPACE` creates a **locked** server: memory tools do not expose a `space` parameter and every call uses that space. Without either selector, it starts in **multi-space** mode: `me_space_list` is available and every memory tool requires `space`. Project configuration and your stored active space never select an MCP space. This makes manual MCP setup work without any local Memory Engine configuration. Authentication is either an API key (`--api-key` or `ME_API_KEY`: a user PAT or service-account key) or, if no key is given, your stored `me login` session token — so a developer install needs no key at all. The server URL defaults to `https://api.memory.build` but can be overridden with `--server` or `ME_SERVER`.

MCP calls always run as the principal represented by the presented credential. A normal local install uses your login session. For an unattended or restricted installation, pass a restricted PAT or service-account key and expose no stronger credential to that process. A per-tool `space` only selects the target space; the server still checks membership and the credential's grants, including restricted-key declarations.

## Setup

### Prerequisites

Log in with `me login` to run the MCP server locally. Selecting a space is optional: omitting it starts multi-space mode. For an unattended installation, mint an API key and pass it with `--api-key`. For least privilege, use a restricted PAT or service-account key, for example `me apikey create mcp --allow <space-slug>:/share/project:w`.

The server defaults to `https://api.memory.build`. Pass `--server <url>` only if you're running a self-hosted server.

### Agent-specific installers

```bash
me opencode install
me codex install
```

These commands register Memory Engine with the named tool, writing a `me mcp` invocation into the tool's MCP configuration. By default they embed no key — the server uses your `me login` session at runtime. Pass `--api-key` to pin a user PAT or service-account key instead, `--space <slug>` to pin a space, and `--server <url>` to pin a non-default server. For a restricted key, the pinned space must be one of its declarations.

### Manual multi-space setup

You can configure any stdio MCP client directly, without running a harness installer or creating a local harness profile:

```bash
me mcp --server <url> --api-key <key>
```

This starts multi-space mode. Call `me_space_list` first, then pass one
of its slugs as the required `space` argument to a memory tool. Add `--space
<slug>` only when you want to lock that MCP process to one space.

See the agent-specific command references for details: [`me opencode install`](cli/me-opencode.md#me-opencode-install) and [`me codex install`](cli/me-codex.md#me-codex-install).

These installers are mechanical and **dormant**: they wire up the MCP entry and (for Claude Code and OpenCode) the capture plumbing, but they never log in, write credentials, or turn anything on. Enable capture and point it at a server, space, and tree with [`me init`](cli/me-init.md); inspect the policy that applies to a directory with [`me doctor`](cli/me-doctor.md).

| Tool | Install command |
|------|-----------------|
| OpenCode | `me opencode install` |
| Codex CLI | `me codex install` |
| Claude Code | `me claude install` (full plugin) / `me claude install --mcp-only` |

### Claude Code

```bash
me claude install            # full plugin: hooks + slash commands + MCP
me claude install --mcp-only # or just the MCP server
```

By default `me claude install` installs the Memory Engine plugin, driving Claude Code's native plugin flow for you (`claude plugin marketplace add` + `claude plugin install`) without pinning `server`, `space`, or `api_key` into the plugin. The plugin resolves your live `me` login config at runtime. Pass `--server` / `--space` to pin those values, or `--api-key` for a headless install that bakes in a fixed key + space. The plugin provides the MCP server and captures Claude Code session events as memories. After installing, restart Claude Code (or run `/plugin`) to load the hooks and slash commands; re-run `/plugin` → `memory-engine` → Configure to adjust options. To run the underlying flow by hand instead:

```bash
claude plugin marketplace add timescale/memory-engine
claude plugin install memory-engine@memory-engine [--scope user|project|local]
```

See [`me claude install`](cli/me-claude.md#me-claude-install) for the full option reference.

### Codex CLI

```bash
me codex install
```

To configure manually:

```bash
codex mcp add me -- me mcp --api-key <key> --space <slug> --server <url>
```

### OpenCode

`me opencode install` edits `~/.config/opencode/opencode.json` directly, adding an entry under `mcp.me`. To configure manually, add this to that file:

```json
{
  "mcp": {
    "me": {
      "type": "local",
      "command": ["me", "mcp", "--api-key", "<key>", "--space", "<slug>", "--server", "<url>"]
    }
  }
}
```

### VS Code / GitHub Copilot

Add a `.vscode/mcp.json` file to your workspace:

```json
{
  "servers": {
    "me": {
      "command": "me",
      "args": ["mcp", "--api-key", "<key>", "--space", "<slug>", "--server", "<url>"]
    }
  }
}
```

This makes Memory Engine available to GitHub Copilot in agent mode. Commit this file to share the configuration with your team (use environment variables or input variables for the API key in shared configs).

To configure globally across all workspaces, open the Command Palette and run **MCP: Open User Configuration**.

### Zed

Open your Zed settings (`Zed > Settings > Open Settings` or `~/.config/zed/settings.json`) and add:

```json
{
  "context_servers": {
    "me": {
      "command": "me",
      "args": ["mcp", "--api-key", "<key>", "--space", "<slug>", "--server", "<url>"]
    }
  }
}
```

After saving, check the Agent Panel settings — the indicator next to "me" should turn green when the server is active.

### Other MCP clients

Any tool that supports the MCP stdio transport can use Memory Engine. The server command is:

```bash
me mcp --api-key <key> --server <url>
```

Point your client at this command with `stdio` as the transport type. This is
multi-space mode: call `me_space_list`, then pass `space` to each memory
tool. Add `--space <slug>` to lock the server to one space instead.

## Available tools

Once connected, the agent has access to:

| Tool | Purpose |
|------|---------|
| `me_space_list` | List spaces available for per-call selection (multi-space mode only) |
| `me_memory_context` | Show current identity, active space, and effective access |
| `me_memory_create` | Store a new memory |
| `me_memory_search` | Search by meaning, keywords, or filters |
| `me_memory_get` | Retrieve a memory by ID |
| `me_memory_get_by_path` | Retrieve a named memory by its `tree/name` path |
| `me_memory_update` | Modify an existing memory |
| `me_memory_delete` | Delete a memory by ID |
| `me_memory_delete_by_path` | Delete a named memory by its `tree/name` path |
| `me_memory_delete_tree` | Bulk delete by tree prefix |
| `me_memory_count` | Count memories matching a tree filter |
| `me_memory_copy` | Copy memories between tree paths |
| `me_memory_mv` | Move memories between tree paths |
| `me_memory_tree` | View the tree structure |
| `me_memory_import` | Bulk import from file or content |
| `me_memory_export` | Bulk export with filters |

See the [MCP Tool Reference](mcp/index.md) for detailed documentation on each tool.

## The AGENTS.md pattern

The most effective way to use Memory Engine with AI agents is the **AGENTS.md pattern**: put a file called `AGENTS.md` in your project root that teaches the agent how to use memory.

A good AGENTS.md includes:

- **Memory map** -- what's stored where in the tree hierarchy, so the agent knows what to search for.
- **Search examples** -- concrete examples of semantic, fulltext, and hybrid searches.
- **Conventions** -- your tree path structure, metadata conventions, and when to store vs. search.
- **Proactive search instructions** -- tell the agent to search memory before starting work, when making decisions, and after completing work.

### Example

```markdown
# Project Memory

This project uses Memory Engine for persistent knowledge.

## Memory Map

- `/share/design/*` -- architecture decisions and design docs
- `/share/research/*` -- research findings and comparisons
- `/share/bugs/*` -- known issues and workarounds

## How to Search

Search memory proactively:
- Before starting work: search for prior art and context
- When making decisions: check if the topic was decided before
- After completing work: store decisions and findings

## Search Examples

# Hybrid search (meaning + keywords)
me_memory_search({semantic: "database-generated identifiers", fulltext: "database-generated identifiers"})

# Semantic search (by meaning)
me_memory_search({semantic: "how does authentication work"})

# Keyword search
me_memory_search({fulltext: "OAuth JWT"})

# Browse a section
me_memory_search({tree: "/share/design/*"})
```

## Troubleshooting

### MCP server shows "failed" or "disabled"

1. Verify the `me` binary is on your PATH: `which me`
2. Test the server directly: `echo '{}' | me mcp --api-key <key> --space <slug> --server <url>`
3. Re-install with the agent-specific command, for example `me opencode install` or `me codex install`. For Claude Code, open `/plugin` and reconfigure `memory-engine`.

### Agent can't find memories

1. Check the MCP execution context with `me_memory_context`.
2. Check that the correct space is active: `me whoami`.
3. Verify memories exist: `me memory search --fulltext "<keyword>"`.
4. Check that embeddings have been computed: `me memory get <id>` (look for `hasEmbedding: true`).
