# me codex

Codex CLI integration commands.

## Commands

- [me codex install](#me-codex-install) -- install dormant Codex plumbing
- [me codex uninstall](#me-codex-uninstall) -- remove recorded Codex plumbing
- [me codex env-hook](#me-codex-env-hook) -- internal helper (you never run this directly)
- [me codex import](#me-codex-import) -- import Codex sessions from `~/.codex/sessions` and `~/.codex/archived_sessions`

---

## me codex install

Register `me` as an MCP server with Codex CLI.

```bash
me codex install
```

This non-interactive command registers an identified managed MCP command and
installs user-global Codex hooks: a `PreToolUse` Bash hook that only injects
`AI_AGENT=codex` and `ME_PROJECT_DIR` into Bash commands, plus transcript-capture
hooks (on session `Stop` and `SessionEnd`). The install writes no credentials,
server, space, tree, cwd, or project configuration — capture stays dormant until
you enable it and point it at a server, space, and tree with
[`me init`](me-init.md) (inspect the policy that applies to a directory with
[`me doctor`](me-doctor.md)).

The MCP registration allows Codex to forward `ME_API_KEY`, `ME_SERVER`, and
`ME_SPACE` when they are present in Codex's environment. Their values are not
written to `~/.codex/config.toml`; restart Codex after changing them.

Codex requires you to approve the installed hooks through `/hooks`. Memory
Engine never automates or bypasses this trust approval.

## me codex uninstall

```bash
me codex uninstall
```

Removes only the MCP registration and matching `PreToolUse` hook recorded by
`me codex install`, preserving unrelated hook configuration.

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
