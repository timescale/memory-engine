# me codex

Codex CLI integration commands.

## Commands

- [me codex install](#me-codex-install) -- register `me` as an MCP server with Codex CLI
- [me codex uninstall](#me-codex-uninstall) -- remove the recorded MCP registration
- [me codex env-hook](#me-codex-env-hook) -- internal helper (you never run this directly)
- [me codex import](#me-codex-import) -- import Codex sessions from `~/.codex/sessions` and `~/.codex/archived_sessions`

---

## me codex install

Register `me` as an MCP server with Codex CLI.

```bash
me codex install
```

This non-interactive command registers exactly `me mcp`. The dormant Codex
adapter also supports a user-global `PreToolUse` Bash hook that only injects
`AI_AGENT=codex` and `ME_PROJECT_DIR` into Bash commands; it has no
credentials, server, space, tree, cwd, or project configuration.

Codex requires you to approve new or changed hooks. Run `/hooks` inside Codex
and approve the entry after installation. Memory Engine never automates or
bypasses this trust approval.

## me codex uninstall

```bash
me codex uninstall
```

Removes only the registration recorded by `me codex install`. When the dormant
adapter's hook artifact is recorded, it removes only the matching
`PreToolUse` entry and preserves unrelated hook configuration.

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

### Known gap: Codex Desktop and the VS Code extension

Under the Codex **terminal CLI**, `me mcp` can use its project directory. The
Codex **Desktop app** and **VS Code extension** have unreliable MCP working
directory propagation, so they use the `defaults` profile unless you configure
a provider-native per-server `cwd` pointing at the project directory. The
terminal CLI is unaffected.

---

## me codex env-hook

An internal helper invoked by the dormant user-global `PreToolUse` Bash hook.
It fails open for malformed or unknown payloads.

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
