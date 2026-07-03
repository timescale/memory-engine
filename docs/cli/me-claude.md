# me claude

Claude Code integration commands.

## Commands

- [me claude install](#me-claude-install) -- install the Memory Engine plugin for Claude Code (full plugin by default, `--mcp-only` for just the MCP server)
- [me claude init](#me-claude-init) -- one-shot setup: backfill sessions, import git history, install the post-commit hook, record the project's memory location in CLAUDE.md
- [me claude hook](#me-claude-hook) -- invoked by the Claude Code plugin to capture events as memories
- [me claude import](#me-claude-import) -- import Claude Code sessions from `~/.claude/projects`

---

## me claude install

Install the **one, user-scoped** Memory Engine plugin for Claude Code — run it once and it applies to every project.

By default this installs the **full plugin** -- hooks (session capture, inert until you opt in), slash commands, and the MCP tools -- by driving Claude Code's native plugin CLI for you:

```
me claude install [options]
```

Under the hood it runs the equivalent of:

```bash
claude plugin marketplace add timescale/memory-engine
claude plugin install --scope user memory-engine@memory-engine \
  [--config server=<url>] [--config space=<slug>] [--config api_key=<key>]
```

The marketplace step is idempotent (skipped if already configured). **By default nothing is pinned into the plugin** -- `server`, `space`, and `api_key` are left blank so the plugin (hooks + MCP) tracks your live `me` config at runtime: your `me login` server, active space, and session. Pinning is opt-in: `--server` / `--space` pin those, and `--api-key` marks a headless install (see below). After install, restart Claude Code (or run `/plugin`) to load the hooks and slash commands.

A session (non-headless) install then:

1. **Persists global defaults** into `~/.config/me` — the resolved server (`default_server`) and active space. The private `~/projects` tree root and "no agent" are code defaults — install never writes them; to change the default tree root machine-wide, set [`tree_root`](../project-config.md#changing-the-default-tree-root-tree_root) in `~/.config/me/config.yaml` by hand.
2. **Asks whether to turn on session capture** (default **no** — the capture hook ships inert). Say **yes** and it enables the machine-wide `capture: true` and runs a one-time machine-wide [`me import claude`](me-import.md) backfill — everything lands **privately** under `~/projects/<slug>`, per project. Say no and you get the tools only. Re-run `me claude install` any time to change the answer; a project's [`.me/config.yaml` `capture`](../project-config.md#the-capture-field-session-capture-onoff) overrides per project either way. (Non-interactive runs skip the prompt and leave the setting untouched.)

Pass `--mcp-only` to skip the plugin and register just the `me` MCP server (no hooks, no slash commands -- the previous default behavior).

| Option | Description |
|--------|-------------|
| `--mcp-only` | Register only the `me` MCP server (no hooks or slash commands). |
| `--api-key <key>` | API key for a headless agent. Default: the plugin/MCP server uses your `me login` session, resolved at runtime. |
| `--space <slug>` | Pin a space. Default: resolve `ME_SPACE` / active space at runtime. |
| `--server <url>` | Pin a server. Default: use your `me login` server at runtime. |

Credential handling: by default (a personal install) nothing is pinned, so the plugin (and the MCP server) uses your `me login` session, server, and active space, resolved from the OS keychain / `~/.config/me` at runtime — so it follows `me login` / `me space use` and survives re-login. Pass `--server` / `--space` to pin either. Pass `--api-key` (mint one with `me apikey create` for a personal access token, or `me apikey create --agent <agent>` for an agent) for a **headless** install that can't reach your keychain — since there's no session to fall back to, an api key bakes in a fixed server + space + key together (and skips the defaults/capture steps above — the operator's `~/.config/me` is not necessarily the agent's; capture is credential-agnostic, so a headless deployment opts in via a committed `.me` `capture: true` or `capture: true` in the target machine's config). The space is resolved from `--space`, `ME_SPACE`, or your active space (whichever is set — install errors if none, since a global key has no active space to fall back to at runtime), and `--server` defaults to your resolved server.

There is no `--scope` flag: the plugin is always installed at **user** scope (once, for all projects). Per-project behavior — a shared tree, a pinned space, a project agent, capture on/off — comes from the committed [`.me/config.yaml`](../project-config.md), which the single installed plugin reads per project.

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

---

## me claude init

One-shot setup of Claude Code memory integration for the current project.

```
me claude init [options]
```

Setup is a list of independent steps, grouped by source: Claude Code sessions and git history each pair a **one-time backfill** of existing data with **ongoing capture** of new activity going forward. In an interactive terminal `init` presents a grouped multiselect of all steps (each pre-checked) so you can deselect any; non-interactively it runs every step except those turned off by a `--skip-<step>` flag.

| Group | Step | Skip flag | What it does |
|-------|------|-----------|--------------|
| Claude Code sessions | Import existing sessions (one-time backfill) | `--skip-transcript-import` | Backfills sessions recorded in this project (cwd at/under the repo root, temp-dir projects included) from `~/.claude/projects`. For a machine-wide backfill across all projects, run [`me import claude`](me-import.md#me-import-claude--codex--opencode). |
| Claude Code sessions | Install the Claude Code plugin (ongoing capture) | `--skip-plugin-install` | Installs the plugin (the same user-scoped install as [`me claude install`](#me-claude-install), login-session auth) **and enables the machine-wide capture setting** — selecting this step is the capture opt-in, so its hooks capture each new session as you work (privately, under `~/projects/<slug>`), plus slash commands and MCP tools. Hidden when the `claude` binary isn't on PATH; when `claude plugin list` already shows the plugin, the picker offers it unchecked as "Reinstall … (already installed)" (non-interactive runs report it as a ✓ line and skip it). |
| Git history | Import existing commit history (one-time backfill) | `--skip-git-import` | Imports the repo's full commit history — the same import as [`me import git`](me-import.md#me-import-git). Skipped automatically when the current directory is not inside a git repo. |
| Git history | Install a git post-commit hook (ongoing capture) | `--skip-git-hook` | Installs the managed hook from [`me import git-hook`](me-import.md#me-import-git-hook) so each new commit triggers a background incremental import. Hidden outside a git repo or when a `core.hooksPath` manager owns the hook path; when the hook is already installed, the picker offers it unchecked as "Reinstall … (already installed)" (non-interactive runs report it as a ✓ line and skip it). |
| Project config | Add a memory pointer to CLAUDE.md | `--skip-claude-md` | Upserts a managed block into the project's CLAUDE.md naming the project tree (the [`.me/config.yaml` `tree`](../project-config.md) when set, else the private `~/projects/<slug>`), its `agent_sessions` and `git_history` nodes, and how to search them. Idempotent — re-runs replace the block in place. When the block is already present and up to date, the picker offers it unchecked as "Rewrite … (already present)" (non-interactive runs report it as a ✓ line and skip it); a stale block (e.g. the active space changed) keeps the step pre-checked so the re-run refreshes it. |

Re-running `init` is safe: both imports are incremental/idempotent and the CLAUDE.md block is replaced, not duplicated. After the steps run, `init` closes with a recap of what is now covered — historical data imported, hooks keeping it updated going forward.

---

## me claude hook

Invoked by the Claude Code plugin on `Stop` (each turn) and `SessionEnd`. Reads the `transcript_path` from the event JSON on stdin, resolves config from `CLAUDE_PLUGIN_OPTION_*` env vars (falling back to your `me login` session), and imports the session transcript — the same parse + write as [`me … import`](agent-session-imports.md), incremental so each call only writes messages new since the last.

**Inert unless capture is enabled**: capture resolves project [`.me/config.yaml` `capture`](../project-config.md#the-capture-field-session-capture-onoff) → the machine-wide setting (the [`me claude install`](#me-claude-install) prompt) → off. With capture off the hook exits 0 silently. Once on, captures land privately under `~/projects/<slug>` unless the project's `.me` `tree` says otherwise.

```
me claude hook --event <name>
```

| Option | Description |
|--------|-------------|
| `--event <name>` | Hook event name (required). |

This command is not run directly -- the Claude Code plugin calls it. The plugin (which includes hooks, slash commands, and MCP) is installed by [me claude install](#me-claude-install), which drives Claude Code's native plugin flow for you. You can also run that flow by hand:

```bash
claude plugin marketplace add timescale/memory-engine
claude plugin install --scope user memory-engine@memory-engine
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
