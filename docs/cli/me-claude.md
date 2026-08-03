# me claude

Claude Code integration commands.

## Commands

- [me claude install](#me-claude-install) -- install dormant Claude plumbing
- [me claude uninstall](#me-claude-uninstall) -- remove recorded Claude plumbing
- [me claude env](#me-claude-env) -- internal SessionStart helper
- [me claude hook](#me-claude-hook) -- internal capture helper
- [me claude import](#me-claude-import) -- import Claude Code sessions

## me claude install

```bash
me claude install
```

This mechanical, non-interactive command creates a user-scoped Claude MCP
registration that runs exactly `me mcp`. It does not prompt, log in, write
credentials, backfill sessions, enable capture, select a server or space, or
write repository configuration.

## me claude uninstall

```bash
me claude uninstall
```

Removes only the recorded user-scoped MCP registration. Existing or modified
Claude configuration is preserved.

## me claude env

An internal SessionStart helper. It provides `AI_AGENT=claude` and
`ME_PROJECT_DIR` to Claude shell commands. It does not activate Memory Engine
features or set credentials.

## me claude hook

An internal, best-effort capture helper. It exits successfully without a
network call or memory write unless the machine-local capture profile enables
Claude for the session directory.

## me claude import

Import Claude Code sessions from `~/.claude/projects/<encoded-cwd>/<session>.jsonl`.
This is an alias of [`me import claude`](me-import.md#me-import-claude--codex--opencode).

```bash
me claude import [options]
```

See [agent session imports](agent-session-imports.md) for the full option
reference, tree layout, idempotency rules, content shape, and metadata schema.
