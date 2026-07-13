# MCP Integration

Memory Engine integrates with AI coding agents via the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). This gives agents 14 memory tools they can use to store and retrieve knowledge across conversations.

## How it works

When an AI tool launches `me mcp`, it spawns a child process that communicates over **stdin/stdout** using the MCP protocol. The process is a stateless proxy — each tool call is translated into an HTTP request to the Memory Engine API. No data is stored locally.

```
┌──────────────┐   stdio (JSON-RPC)   ┌──────────┐   HTTPS   ┌────────────────┐
│   AI Agent   │ ◄──────────────────► │  me mcp  │ ────────► │ Memory Engine  │
└──────────────┘                      └──────────┘           └────────────────┘
```

The AI agent never sees or handles credentials — it just calls MCP tools and gets results back.

Each `me mcp` instance is locked to a single **space**, carried as the `X-Me-Space` header. The space is resolved from `--space` > `ME_SPACE` > your stored active space. Authentication is **either** an API key (`--api-key` or `ME_API_KEY`: user PAT, agent key, or service-account key) **or**, if no key is given, your stored `me login` session token — so a developer install needs no key at all. The server URL defaults to `https://api.memory.build` but can be overridden with `--server` or `ME_SERVER`.

### Agent-by-config

`me mcp` is a harness surface, so it acts as a configured **agent** automatically — no `--as-agent` flag needed. It resolves the project's [`.me/config.yaml`](project-config.md) `agent`, else your global `~/.config/me/config.yaml` `agent`, and sends every request as that agent (`X-Me-As-Agent`) — so an agent's memory work is attributable and scoped to its own grants, not yours. It validates the resolved agent eagerly at startup (one `whoami` round trip): a name that doesn't exist yet, or isn't admitted to the space, fails the server at launch with an actionable message rather than 403ing on every tool call. If neither config defines an `agent`, `me mcp` refuses to start — see [Project config](project-config.md#agent-by-config-and-the-agent-field) for the `.user` opt-out and how the default agent gets provisioned. This doesn't apply when you pass `--api-key`/`ME_API_KEY` for a dedicated agent key — the key already *is* the agent.

## Setup

### Prerequisites

Log in with `me login` and select a space — `me whoami` shows your active space and identity. That session is enough to run the MCP server locally. For an unattended install, mint an API key — `me apikey create` for a personal access token (acts as you), `me apikey create --agent <agent>` for a dedicated agent, or `me apikey create --service <service>` for a team-owned service account — and pass it with `--api-key`.

The server defaults to `https://api.memory.build`. Pass `--server <url>` only if you're running a self-hosted server.

### Agent-specific installers

```bash
me opencode install
me codex install
me gemini install
```

These commands register Memory Engine with the named tool, writing a `me mcp` invocation into the tool's MCP configuration. By default they embed no key — the server uses your `me login` session at runtime. Pass `--api-key` to pin a user PAT, dedicated agent key, or service-account key instead, `--space <slug>` to pin a space, and `--server <url>` to pin a non-default server.

See the agent-specific command references for details: [`me opencode install`](cli/me-opencode.md#me-opencode-install), [`me codex install`](cli/me-codex.md#me-codex-install), and [`me gemini install`](cli/me-gemini.md#me-gemini-install).

[`me project init`](cli/me-project.md) goes further than any of the installers above: it's a harness-agnostic, per-project wizard that backfills existing sessions (for whichever of Claude Code/OpenCode/Codex actually has any), installs a capture plugin so new sessions are captured automatically, and writes a memory pointer into `CLAUDE.md`/`AGENTS.md`. Its preflight also offers to run `me claude install`/`me opencode install` for you if a harness is detected but not yet set up.

`me opencode install` takes `--scope project|user`. Project scope writes into the repo (`opencode.json` + `.opencode/`) so the integration can be committed and shared with a team (no key is embedded — credentials resolve from each teammate's `me login`); user scope (the default) writes the global `~/.config/opencode/` config instead. `me project init`'s preflight always installs OpenCode at user scope — run `me opencode install --scope project` directly for a team-committed setup.

| Tool | Install command |
|------|-----------------|
| OpenCode | `me opencode install` |
| Codex CLI | `me codex install` |
| Gemini CLI | `me gemini install` |
| Claude Code | `me claude install` (full plugin) / `me claude install --mcp-only` |

### Claude Code

```bash
me claude install            # full plugin: hooks + slash commands + MCP
me claude install --mcp-only # or just the MCP server
```

By default `me claude install` installs the Memory Engine plugin, driving Claude Code's native plugin flow for you (`claude plugin marketplace add` + `claude plugin install`) and passing your resolved `server` / `space` / `api_key` through `--config`. The plugin provides the MCP server and captures Claude Code session events as memories. After installing, restart Claude Code (or run `/plugin`) to load the hooks and slash commands; re-run `/plugin` → `memory-engine` → Configure to adjust options. To run the underlying flow by hand instead:

```bash
claude plugin marketplace add timescale/memory-engine
claude plugin install memory-engine@memory-engine [--scope user|project|local]
```

See [`me claude install`](cli/me-claude.md#me-claude-install) for the full option reference.

### Gemini CLI

```bash
me gemini install
```

To configure manually:

```bash
gemini mcp add --scope user me me mcp --api-key <key> --space <slug> --server <url>
```

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
me mcp --api-key <key> --space <slug> --server <url>
```

Point your client at this command with `stdio` as the transport type.

## Available tools

Once connected, the agent has access to:

| Tool | Purpose |
|------|---------|
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
3. Re-install with the agent-specific command, for example `me opencode install`, `me codex install`, or `me gemini install`. For Claude Code, open `/plugin` and reconfigure `memory-engine`.

### Agent can't find memories

1. Check that the correct space is active: `me whoami`
2. Verify memories exist: `me memory search --fulltext "<keyword>"`
3. Check that embeddings have been computed: `me memory get <id>` (look for `hasEmbedding: true`)
