# me codex

Codex CLI integration commands.

## Commands

- [me codex install](#me-codex-install) -- register `me` as an MCP server with Codex CLI
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

By default only the server URL is baked into the config: at runtime `me mcp` uses your `me login` session (resolved from the OS keychain / `~/.config/me` each run, so it survives re-login) and your active space (set by `me space use` / `ME_SPACE`). Pass `--api-key` (mint one with `me apikey create <agent>`) for a headless agent that cannot reach your keychain; that bakes the key and requires a pinned `--space`.

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

---

## me codex import

Import Codex sessions from `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and `~/.codex/archived_sessions/*.jsonl`.

```
me codex import [options]
```

See [agent session imports](agent-session-imports.md) for the full option reference, tree layout, idempotency rules, content shape, and metadata schema.

Codex sessions include git commit, branch, and remote URL in `session_meta`, so the importer captures all three. Both the recent on-disk format (with a leading `session_meta` line wrapping payloads in `response_item` / `event_msg`) and the legacy format (bare response-item-like objects per line) are handled.

Reasoning and function-call response items don't always carry a native id. In those cases the importer synthesizes a stable id from `(session_id, type, ordinal)` so re-imports remain idempotent.

Injected Codex wrapper messages like `# AGENTS.md instructions ...`, `<user_instructions>...</user_instructions>`, `<environment_context>...</environment_context>`, and `<turn_aborted>...</turn_aborted>` are ignored.
