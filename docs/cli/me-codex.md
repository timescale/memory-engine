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
| `--api-key <key>` | API key for a headless install. Default: the MCP server uses your `me login` session, resolved at runtime. |
| `--space <slug>` | Lock MCP to this space. Without it, MCP is multi-space unless `ME_SPACE` is set. |
| `--server <url>` | Server URL to embed in the MCP config. |

By default only the server URL is baked into the config: at runtime `me mcp` uses your `me login` session (resolved from the OS keychain / `~/.config/me` each run, so it survives re-login). MCP is multi-space unless the generated command includes `--space` or its environment sets `ME_SPACE`: agents call `me_space_list`, then pass `space` to every memory tool. Your active space does not select an MCP space. Pass `--space` to lock the MCP tools to one space. Pass `--api-key` for a headless install that cannot reach your keychain; it may also run multi-space. For least privilege, mint a restricted PAT or service-account key with `me apikey create --allow <space>:<path>:<r|w|o>`; a pinned space must be declared by that key.

`me codex install` also adds a hook to `~/.codex/hooks.json` so that a plain `me` call from Codex's shell can discover the active project after a directory change. Re-running install is safe and leaves any other hooks you've configured untouched. **One-time step**: Codex holds new hooks for review — run `/hooks` inside Codex once to approve it.

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

### Known gap: Codex Desktop and the VS Code extension

Under the Codex **terminal CLI**, `me mcp` resolves your project the ordinary way — no action needed. The Codex **Desktop app** and **VS Code extension** currently launch MCP servers from the wrong working directory, so `me mcp` cannot use a project's `.me/config.yaml` for server resolution and falls back to global configuration. MCP space selection is unaffected: an unpinned server is always multi-space. The workaround is to set a per-server `cwd` pointing at your project directory in Codex's own MCP config. The terminal CLI is unaffected.

---

## me codex env-hook

An internal helper that Codex invokes automatically through the hook `me codex install` adds. It makes a plain `me` call from Codex's Bash tool resolve the right project. **You never run this by hand**, and it's designed to fail open — if it can't recognize a command it does nothing, so your commands always run.

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
