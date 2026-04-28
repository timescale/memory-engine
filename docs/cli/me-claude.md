# me claude

Claude Code integration commands.

## Commands

- [me claude install](#me-claude-install) -- register `me` as an MCP server with Claude Code (MCP-only)
- [me claude hook](#me-claude-hook) -- invoked by the Claude Code plugin to capture events as memories
- [me claude import](#me-claude-import) -- import Claude Code sessions from `~/.claude/projects`

---

## me claude install

Register `me` as an MCP server with Claude Code.

This is the **MCP-only** install path: it adds the `me` tools to Claude Code without installing the full Memory Engine plugin. If you want hooks (auto-capture of Claude Code events) and slash commands, install the plugin instead -- see [me claude hook](#me-claude-hook).

```
me claude install [options]
```

| Option | Description |
|--------|-------------|
| `--api-key <key>` | API key to embed in the MCP config. |
| `--server <url>` | Server URL to embed in the MCP config. |
| `-s, --scope <scope>` | Claude Code config scope: `local`, `user`, or `project`. Default: `user`. |

If no `--api-key` or `--server` is provided, values are resolved from `~/.config/me/credentials.yaml` (set by `me login` and `me engine use`).

The `--scope` flag mirrors `claude mcp add --scope`:

- `local` -- registration scoped to the current project on this machine only.
- `user` -- registration available to all projects for your user (default).
- `project` -- registration committed to the current project (e.g. checked into `.claude/`).

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

---

## me claude hook

Invoked by the Claude Code plugin. Reads the event JSON from stdin, resolves config from `CLAUDE_PLUGIN_OPTION_*` env vars, and captures the event as a memory.

```
me claude hook --event <name>
```

| Option | Description |
|--------|-------------|
| `--event <name>` | Hook event name (required). |

This command is not run directly -- the Claude Code plugin calls it. The plugin (which includes hooks, slash commands, and MCP) is installed via Claude Code's native flow:

```bash
claude plugin marketplace add timescale/memory-engine
claude plugin install memory-engine@memory-engine [--scope user|project|local]
# then, in a Claude Code session:
/plugin  # select memory-engine, Configure, fill api_key/server/tree_prefix
```

If you only want the MCP tools (no hooks, no slash commands), use [me claude install](#me-claude-install) instead.

Best-effort: logs failures to stderr but always exits 0 so that a hook failure never blocks a Claude Code session.

---

## me claude import

Import Claude Code sessions from `~/.claude/projects/<encoded-cwd>/<session>.jsonl`.

```
me claude import [options]
```

See [agent session imports](agent-session-imports.md) for the full option reference, tree layout, idempotency rules, content shape, and metadata schema.

**Default filters (off by default, opt in via flags):**

- Sidechain (`agent-*.jsonl`) files are skipped. These are subagent/Task spawns. Opt in with `--include-sidechains`.
- Sessions whose cwd is under `/tmp`, `/private/tmp`, `/private/var/folders`, or `/var/folders` are skipped. Opt in with `--include-temp-cwd`.
- Sessions with fewer than 2 user messages are skipped (one-shot queries, warm-up pings, and aborted sessions). Opt in with `--include-trivial`.

### Example

First-time import of Claude history for a specific project, as a dry run:

```bash
me claude import --project /Users/me/dev/memory-engine --dry-run --verbose
```
