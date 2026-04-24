# me claude

Claude Code integration commands.

## Commands

- [me claude hook](#me-claude-hook) -- invoked by the Claude Code plugin to capture events as memories
- [me claude import](#me-claude-import) -- import Claude Code sessions from `~/.claude/projects`

---

## me claude hook

Invoked by the Claude Code plugin. Reads the event JSON from stdin, resolves config from `CLAUDE_PLUGIN_OPTION_*` env vars, and captures the event as a memory.

```
me claude hook --event <name>
```

| Option | Description |
|--------|-------------|
| `--event <name>` | Hook event name (required). |

This command is not run directly -- the Claude Code plugin calls it. The plugin is installed via Claude Code's native flow:

```bash
claude plugin marketplace add <source>
claude plugin install memory-engine@memory-engine [--scope user|project|local]
# then, in a Claude Code session:
/plugin  # select memory-engine, Configure, fill api_key/server/tree_prefix
```

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
