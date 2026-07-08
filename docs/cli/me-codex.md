# me codex

Codex CLI integration commands.

## Commands

- [me codex install](#me-codex-install) -- register `me` as an MCP server with Codex CLI, and wire the harness-injected shell contract
- [me codex env-hook](#me-codex-env-hook) -- invoked by the PreToolUse hook to inject the harness contract into Bash commands
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

`me codex install` also writes a user-scope PreToolUse hook into `~/.codex/hooks.json` (see [`me codex env-hook`](#me-codex-env-hook) below) that injects the harness-agent environment contract into every Bash command Codex runs — a re-run is idempotent (byte-identical → no-op) and never disturbs any other hooks you've configured. **One-time step**: Codex trusts hooks by the hash of their definition and holds new ones for review — run `/hooks` inside Codex once to approve it. Until then (or if the hook is somehow removed), a plain `me` call from Codex's shell fails closed rather than silently running as you; `me codex install` prints this reminder, and a later `me doctor` will detect the untrusted state and point at the same fix.

Unless a session install already used `--no-default-agent` or a global `agent:` is already set, install also provisions a default agent (adopts-or-creates `coder`) — see [Agent-by-config](../project-config.md#agent-by-config-and-the-agent-field).

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

### Known gap: Codex Desktop and the VS Code extension

Codex's MCP servers spawn correctly at the session's project directory under the terminal CLI, so `me mcp` resolves the project the ordinary way. The **Desktop app** and the **VS Code extension** hosts have open upstream bugs where the MCP server's spawn cwd isn't the workspace ([openai/codex#16390](https://github.com/openai/codex/issues/16390), [openai/codex#9989](https://github.com/openai/codex/issues/9989)) — the server then falls back to your global config (your own session, active space, and global `agent:` if any), not the project's `.me/config.yaml`. There's no client-side fix (Codex spawns with a cleared env and advertises no MCP `roots`, so nothing else reaches the server); the workaround is a **per-server `cwd`** in Codex's own MCP config, pointed at the project directory. This is a Desktop/VS Code-only gap — the terminal CLI is unaffected — and a later `me doctor` will flag when it applies.

---

## me codex env-hook

Invoked by the `PreToolUse` hook `me codex install` writes into `~/.codex/hooks.json` (matcher `^Bash$`). Reads the tool-call payload on stdin and, for a Bash command, prints a rewrite that prepends an `export …; ` prefix — the harness-agent environment contract (`ME_INJECT_V`/`AI_AGENT=codex`/`ME_AS_AGENT=.me`/`ME_PROJECT_DIR=<session cwd>`) — onto the command string. This is what makes a plain `me` call from Codex's Bash tool resolve the right project and run as the configured agent automatically.

```
me codex env-hook
```

Not run directly. Fails open (prints nothing, so the command runs unmodified) on anything it doesn't recognize: a live contract already in its own env (first-writer-wins — Codex was itself launched inside another session's contract), a non-Bash tool call (expected, not logged), or a payload shape it doesn't understand (a Codex update — logged, structure only, so a later `me doctor` can flag "N unrecognized payload shapes — upgrade `me` or file an issue"). Always exits 0.

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
