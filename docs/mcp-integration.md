# MCP Integration

Memory Engine integrates with AI coding agents via the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). This gives agents 10 memory tools they can use to store and retrieve knowledge across conversations.

## Setup

### Automatic

```bash
me mcp install
```

This detects AI tools on your PATH and registers Memory Engine with each one:

| Tool | Detection |
|------|-----------|
| Claude Code | `claude` binary |
| Gemini CLI | `gemini` binary |
| Codex CLI | `codex` binary |
| OpenCode | `opencode` binary (manual setup) |

The command bakes your API key and server URL into the MCP configuration so the agent can authenticate automatically.

### Manual

If automatic detection doesn't work, register manually:

```bash
# Claude Code
claude mcp add --scope user me -- me mcp --api-key <key> --server <url>

# Gemini CLI
gemini mcp add --scope user me me mcp --api-key <key> --server <url>

# Codex CLI
codex mcp add me -- me mcp --api-key <key> --server <url>
```

## Available tools

Once connected, the agent has access to:

| Tool | Purpose |
|------|---------|
| `me_memory_create` | Store a new memory |
| `me_memory_search` | Search by meaning, keywords, or filters |
| `me_memory_get` | Retrieve a memory by ID |
| `me_memory_update` | Modify an existing memory |
| `me_memory_delete` | Delete a memory |
| `me_memory_delete_tree` | Bulk delete by tree prefix |
| `me_memory_mv` | Move memories between tree paths |
| `me_memory_tree` | View the tree structure |
| `me_memory_import` | Bulk import from file or content |
| `me_memory_export` | Bulk export with filters |

See [MCP Tool Reference](mcp/me_memory_search.md) for detailed documentation on each tool.

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

- `design.*` -- architecture decisions and design docs
- `research.*` -- research findings and comparisons
- `bugs.*` -- known issues and workarounds

## How to Search

Search memory proactively:
- Before starting work: search for prior art and context
- When making decisions: check if the topic was decided before
- After completing work: store decisions and findings

## Search Examples

# Semantic search (by meaning)
me_memory_search({semantic: "how does authentication work"})

# Keyword search
me_memory_search({fulltext: "OAuth JWT"})

# Browse a section
me_memory_search({tree: "design.*"})
```

## How it works

When `me mcp` runs, it starts a stdio-based MCP server that acts as a thin proxy to the Memory Engine API. Each tool call is translated into an HTTP request to the engine using the baked-in API key.

The server is stateless -- it holds no data locally. All persistence is handled by the engine.

## Troubleshooting

### MCP server shows "failed" or "disabled"

1. Verify the `me` binary is on your PATH: `which me`
2. Test the server directly: `echo '{}' | me mcp --api-key <key> --server <url>`
3. Re-install: `me mcp install`

### Agent can't find memories

1. Check that the correct engine is active: `me whoami`
2. Verify memories exist: `me memory search --fulltext "<keyword>"`
3. Check that embeddings have been computed: `me memory get <id>` (look for `hasEmbedding: true`)
