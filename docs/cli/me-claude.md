# me claude

Claude Code integration commands.

## Commands

- [me claude install](#me-claude-install) -- install the Memory Engine plugin for Claude Code (full plugin by default, `--mcp-only` for just the MCP server)
- [me claude init](#me-claude-init) -- one-shot setup: backfill sessions, import git history, record the project's memory location in CLAUDE.md
- [me claude hook](#me-claude-hook) -- invoked by the Claude Code plugin to capture events as memories
- [me claude import](#me-claude-import) -- import Claude Code sessions from `~/.claude/projects`

---

## me claude install

Install the Memory Engine plugin for Claude Code.

By default this installs the **full plugin** -- hooks (auto-capture of Claude Code events), slash commands, and the MCP tools -- by driving Claude Code's native plugin CLI for you:

```
me claude install [options]
```

Under the hood it runs the equivalent of:

```bash
claude plugin marketplace add timescale/memory-engine
claude plugin install memory-engine@memory-engine \
  --config server=<url> [--config space=<slug>] [--config api_key=<key>]
```

The marketplace step is idempotent (skipped if already configured), and the resolved `server` / `space` / `api_key` are passed through `--config` -- the same path as the interactive `/plugin` configure flow. After install, restart Claude Code (or run `/plugin`) to load the hooks and slash commands.

Pass `--mcp-only` to skip the plugin and register just the `me` MCP server (no hooks, no slash commands -- the previous default behavior).

| Option | Description |
|--------|-------------|
| `--mcp-only` | Register only the `me` MCP server (no hooks or slash commands). |
| `--api-key <key>` | API key for a headless agent. Default: the plugin/MCP server uses your `me login` session, resolved at runtime. |
| `--space <slug>` | Pin a space. Default: resolve `ME_SPACE` / active space at runtime. |
| `--server <url>` | Server URL to embed in the config. |
| `-s, --scope <scope>` | Claude Code config scope: `local`, `user`, or `project`. Default: `user`. |

Credential handling is the same for both modes: with no `--api-key`, the plugin (and the MCP server) uses your `me login` session, resolved from the OS keychain / `~/.config/me` at runtime (so it survives re-login), and your active space (set by `me space use` / `ME_SPACE`). Pass `--api-key` (mint one with `me apikey create <agent>`) for a headless agent that cannot reach your keychain; that requires a pinned `--space`.

The `--scope` flag mirrors `claude plugin install --scope` / `claude mcp add --scope`:

- `local` -- scoped to the current project on this machine only.
- `user` -- available to all projects for your user (default).
- `project` -- committed to the current project (e.g. checked into `.claude/`).

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

---

## me claude init

One-shot setup of Claude Code memory integration for the current project.

```
me claude init [options]
```

Setup is a list of independent steps. In an interactive terminal `init` presents a multiselect of all steps (each pre-checked) so you can deselect any; non-interactively it runs every step except those turned off by a `--skip-<step>` flag.

| Step | Skip flag | What it does |
|------|-----------|--------------|
| Import existing Claude Code sessions | `--skip-transcript-import` | Backfills sessions from `~/.claude/projects` — the same import as [`me import claude`](me-import.md#me-import-claude--codex--opencode). |
| Import git commit history | `--skip-git-import` | Imports the repo's full commit history — the same import as [`me import git`](me-import.md#me-import-git). Skipped automatically when the current directory is not inside a git repo. |
| Add a memory pointer to CLAUDE.md | `--skip-claude-md` | Upserts a managed block into the project's CLAUDE.md naming the project tree (`share.projects.<slug>`), its `agent_sessions` and `git_history` nodes, and how to search them. Idempotent — re-runs replace the block in place. |

Re-running `init` is safe: both imports are incremental/idempotent and the CLAUDE.md block is replaced, not duplicated.

---

## me claude hook

Invoked by the Claude Code plugin on `Stop` (each turn) and `SessionEnd`. Reads the `transcript_path` from the event JSON on stdin, resolves config from `CLAUDE_PLUGIN_OPTION_*` env vars (falling back to your `me login` session), and imports the session transcript — the same parse + write as [`me … import`](agent-session-imports.md), incremental so each call only writes messages new since the last.

```
me claude hook --event <name>
```

| Option | Description |
|--------|-------------|
| `--event <name>` | Hook event name (required). |

This command is not run directly -- the Claude Code plugin calls it. The plugin (which includes hooks, slash commands, and MCP) is installed by [me claude install](#me-claude-install), which drives Claude Code's native plugin flow for you. You can also run that flow by hand:

```bash
claude plugin marketplace add timescale/memory-engine
claude plugin install memory-engine@memory-engine [--scope user|project|local]
# then, in a Claude Code session:
/plugin  # select memory-engine, Configure (all values optional if logged in)
```

Both `api_key` and `space` are optional: blank `api_key` uses your `me login` session (set it to attribute captures to a dedicated agent), and blank `space` uses your active space (`me space use`; pin it for project/shared installs).

If you only want the MCP tools (no hooks, no slash commands), run [me claude install --mcp-only](#me-claude-install) instead.

Best-effort: logs failures to stderr but always exits 0 so that a hook failure never blocks a Claude Code session.

---

## me claude import

Import Claude Code sessions from `~/.claude/projects/<encoded-cwd>/<session>.jsonl`. This is an alias of [`me import claude`](me-import.md#me-import-claude--codex--opencode).

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
