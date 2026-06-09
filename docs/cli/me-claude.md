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
| `--api-key <key>` | API key for a headless agent. Default: the MCP server uses your `me login` session, resolved at runtime. |
| `--space <slug>` | Pin a space. Default: resolve `ME_SPACE` / active space at runtime. |
| `--server <url>` | Server URL to embed in the MCP config. |
| `-s, --scope <scope>` | Claude Code config scope: `local`, `user`, or `project`. Default: `user`. |

By default only the server URL is baked into the config: at runtime `me mcp` uses your `me login` session (resolved from the OS keychain / `~/.config/me` each run, so it survives re-login) and your active space (set by `me space use` / `ME_SPACE`). Pass `--api-key` (mint one with `me apikey create <agent>`) for a headless agent that cannot reach your keychain; that bakes the key and requires a pinned `--space`.

The `--scope` flag mirrors `claude mcp add --scope`:

- `local` -- registration scoped to the current project on this machine only.
- `user` -- registration available to all projects for your user (default).
- `project` -- registration committed to the current project (e.g. checked into `.claude/`).

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

---

## me claude hook

Invoked by the Claude Code plugin on `Stop` (each turn) and `SessionEnd`. Reads the `transcript_path` from the event JSON on stdin, resolves config from `CLAUDE_PLUGIN_OPTION_*` env vars (falling back to your `me login` session), and imports the session transcript — the same parse + write as [`me … import`](agent-session-imports.md), incremental so each call only writes messages new since the last.

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
/plugin  # select memory-engine, Configure (all values optional if logged in)
```

Both `api_key` and `space` are optional: blank `api_key` uses your `me login` session (set it to attribute captures to a dedicated agent), and blank `space` uses your active space (`me space use`; pin it for project/shared installs).

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
