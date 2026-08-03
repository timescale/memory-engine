# me claude

Claude Code integration commands.

## Commands

- [me claude install](#me-claude-install) -- install the dormant Memory Engine MCP registration
- [me claude uninstall](#me-claude-uninstall) -- remove the recorded MCP registration
- [me claude init](#me-claude-init) -- removed; use [`me project init`](me-project.md)
- [me claude env](#me-claude-env) -- internal helper (you never run this directly)
- [me claude hook](#me-claude-hook) -- internal helper the plugin uses to capture sessions (you never run this directly)
- [me claude import](#me-claude-import) -- import Claude Code sessions from `~/.claude/projects`

---

## me claude install

Install Claude Code's user-scoped dormant MCP registration:

```bash
me claude install
```

This non-interactive command registers exactly `me mcp`. It does not install a
plugin, enable capture, write credentials, or pin a server, space, or project.
Use `me project init` to configure runtime behavior separately.

## me claude uninstall

```bash
me claude uninstall
```

Removes only the registration recorded by `me claude install`.

---

## me claude init

**Removed** — run [`me project init`](me-project.md), the harness-agnostic per-project setup wizard. The retired command prints an error and exits without running the wizard.

---

## me claude env

An internal helper the Memory Engine plugin runs automatically at the start of each Claude Code session. It makes a plain `me` call from Claude's Bash tool resolve the right project even after `cd`. **You never run this by hand** — it's installed by [`me claude install`](#me-claude-install).

---

## me claude hook

An internal helper the Memory Engine plugin runs automatically as a Claude Code session progresses. When session capture is on, it saves the conversation as memories, incrementally (each call only writes what's new). **You never run this by hand.**

**Inert unless capture is enabled**: capture resolves from the project's [`.me/config.yaml` `capture`](../project-config.md#the-capture-field-session-capture-onoff) → your machine-wide setting (the [`me claude install`](#me-claude-install) prompt) → off. With capture off, nothing is written. Once on, captures land privately under `~/projects/<slug>` unless the project's `.me` `tree` says otherwise.

The plugin (hooks, slash commands, and MCP) is installed by [`me claude install`](#me-claude-install), which drives Claude Code's native plugin flow for you. You can also run that flow by hand:

```bash
claude plugin marketplace add timescale/memory-engine
claude plugin install --scope user memory-engine@memory-engine
# then, in a Claude Code session:
/plugin  # select memory-engine, Configure (all values optional if logged in)
```

Both `api_key` and `space` are optional: blank `api_key` uses your `me login` session. Blank `space` leaves MCP multi-space; it does not use your active space. Set `space` to lock MCP and pin capture for a project/shared install.

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
