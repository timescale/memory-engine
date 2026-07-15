# me codex

Codex CLI integration commands.

## Commands

- [me codex install](#me-codex-install) -- register `me` as an MCP server with Codex CLI
- [me codex env-hook](#me-codex-env-hook) -- internal helper (you never run this directly)
- [me codex import](#me-codex-import) -- import Codex sessions from `~/.codex/sessions` and `~/.codex/archived_sessions`

---

## me codex install

Register `me` as an MCP server with Codex CLI.

```
me codex install [options]
```

| Option | Description |
|--------|-------------|
| `--api-key <key>` | API key for a headless agent. Default: the MCP server uses your `me login` session, resolved at runtime. |
| `--space <slug>` | Pin a space. Default: resolve `ME_SPACE` / active space at runtime. |
| `--server <url>` | Server URL to embed in the MCP config. |
| `--no-default-agent` | Skip provisioning the default agent (see [Agent-by-config](../project-config.md#agent-by-config-and-the-agent-field)). |

By default only the server URL is baked into the config: at runtime `me mcp` uses your `me login` session (resolved from the OS keychain / `~/.config/me` each run, so it survives re-login) and your active space (set by `me space use` / `ME_SPACE`). Pass `--api-key` (mint one with `me apikey create --agent <agent>`, or `me apikey create` for a personal access token) for a headless agent that cannot reach your keychain; that bakes the key and requires a pinned `--space`.

`me codex install` also adds a hook to `~/.codex/hooks.json` so that a plain `me` call from Codex's shell automatically runs as your configured agent in the right project. Re-running install is safe and leaves any other hooks you've configured untouched. **One-time step**: Codex holds new hooks for review — run `/hooks` inside Codex once to approve it. Until you do, a plain `me` call from Codex's shell won't run as your agent; `me codex install` prints this reminder.

Unless a session install already used `--no-default-agent` or a valid custom global `agent:` / `.user` opt-out is already set, install also provisions a default agent (adopts-or-creates `coder`) — see [Agent-by-config](../project-config.md#agent-by-config-and-the-agent-field). If a configured global agent is stale, install prompts to create it interactively or fails clearly non-interactively.

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

### Known gap: Codex Desktop and the VS Code extension

Under the Codex **terminal CLI**, `me mcp` resolves your project the ordinary way — no action needed. The Codex **Desktop app** and **VS Code extension** currently launch MCP servers from the wrong working directory, so `me mcp` can't tell which project you're in and falls back to your global config (your own session, active space, and global `agent:` if any) instead of the project's `.me/config.yaml`. The workaround is to set a per-server `cwd` pointing at your project directory in Codex's own MCP config. The terminal CLI is unaffected.

---

## me codex env-hook

An internal helper that Codex invokes automatically through the hook `me codex install` adds. It's what makes a plain `me` call from Codex's Bash tool resolve the right project and run as your configured agent. **You never run this by hand**, and it's designed to fail open — if it can't recognize a command it does nothing, so your commands always run.

---

## me codex import

Import Codex sessions from `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and `~/.codex/archived_sessions/*.jsonl`. This is an alias of [`me import codex`](me-import.md#me-import-claude--codex--opencode).

```
me codex import [options]
```

See [agent session imports](agent-session-imports.md) for the full option reference, tree layout, idempotency rules, content shape, and metadata schema.

Codex sessions include git commit, branch, and remote URL in `session_meta`, so the importer captures all three. Both the recent on-disk format (with a leading `session_meta` line wrapping payloads in `response_item` / `event_msg`) and the legacy format (bare response-item-like objects per line) are handled.

Reasoning and function-call response items don't always carry a native id. In those cases the importer synthesizes a stable id from `(session_id, type, ordinal)` so re-imports remain idempotent.

Injected Codex wrapper messages like `# AGENTS.md instructions ...`, `<user_instructions>...</user_instructions>`, `<environment_context>...</environment_context>`, and `<turn_aborted>...</turn_aborted>` are ignored.
