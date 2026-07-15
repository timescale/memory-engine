# me gemini

Gemini CLI integration commands.

## Commands

- [me gemini install](#me-gemini-install) -- register `me` as an MCP server with Gemini CLI
- [me gemini env-hook](#me-gemini-env-hook) -- internal helper (you never run this directly)

---

## me gemini install

Register `me` as an MCP server with Gemini CLI.

```
me gemini install [options]
```

| Option | Description |
|--------|-------------|
| `--api-key <key>` | API key for a headless agent. Default: the MCP server uses your `me login` session, resolved at runtime. |
| `--space <slug>` | Pin a space. Default: resolve `ME_SPACE` / active space at runtime. |
| `--server <url>` | Server URL to embed in the MCP config. |
| `-s, --scope <scope>` | Gemini CLI config scope: `user` or `project`. Default: `user`. |
| `--no-default-agent` | Skip provisioning the default agent (see [Agent-by-config](../project-config.md#agent-by-config-and-the-agent-field)). |

By default only the server URL is baked into the config: at runtime `me mcp` uses your `me login` session (resolved from the OS keychain / `~/.config/me` each run, so it survives re-login) and your active space (set by `me space use` / `ME_SPACE`). Pass `--api-key` (mint one with `me apikey create --agent <agent>`, or `me apikey create` for a personal access token) for a headless agent that cannot reach your keychain; that bakes the key and requires a pinned `--space`.

`me gemini install` also adds a small hook to `~/.gemini/settings.json` so that a plain `me` call from Gemini CLI's shell tool automatically runs as your configured agent in the right project. Re-running install is safe and leaves any other hooks you've configured untouched.

Unless a session install already used `--no-default-agent` or a valid custom global `agent:` / `.user` opt-out is already set, install also provisions a default agent (adopts-or-creates `coder`) — see [Agent-by-config](../project-config.md#agent-by-config-and-the-agent-field). If a configured global agent is stale, install prompts to create it interactively or fails clearly non-interactively.

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

---

## me gemini env-hook

An internal helper that Gemini CLI invokes automatically through the hook `me gemini install` adds. It's what makes a plain `me` call from Gemini CLI's shell tool resolve the right project and run as your configured agent. **You never run this by hand**, and it's designed to fail open — if it can't recognize a command it does nothing, so your commands always run.
