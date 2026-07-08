# me gemini

Gemini CLI integration commands.

## Commands

- [me gemini install](#me-gemini-install) -- register `me` as an MCP server with Gemini CLI, and wire the harness-injected shell contract
- [me gemini env-hook](#me-gemini-env-hook) -- invoked by the BeforeTool hook to inject the harness contract into shell commands

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

`me gemini install` also writes a user-scope `BeforeTool` hook (matcher `run_shell_command`) into `~/.gemini/settings.json` (see [`me gemini env-hook`](#me-gemini-env-hook) below) that injects the harness-agent environment contract into every shell command Gemini CLI runs — a re-run is idempotent and never disturbs any other hooks you've configured.

Unless a session install already used `--no-default-agent` or a global `agent:` is already set, install also provisions a default agent (adopts-or-creates `coder`) — see [Agent-by-config](../project-config.md#agent-by-config-and-the-agent-field).

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

---

## me gemini env-hook

Invoked by the `BeforeTool` hook `me gemini install` writes into `~/.gemini/settings.json` (matcher `run_shell_command`). Reads the tool-call payload on stdin and, for a shell command, prints a rewrite that prepends an `export …; ` prefix — the harness-agent environment contract (`ME_INJECT_V`/`AI_AGENT=gemini-cli`/`ME_AS_AGENT=.me`/`ME_PROJECT_DIR=<session cwd>`) — onto the command string. This is what makes a plain `me` call from Gemini CLI's shell tool resolve the right project and run as the configured agent automatically.

```
me gemini env-hook
```

Not run directly. Fails open (prints nothing, so the command runs unmodified) on anything it doesn't recognize: a live contract already in its own env (first-writer-wins), a non-shell tool call (expected, not logged), or a payload shape it doesn't understand (a Gemini CLI update — logged, structure only, so a later `me doctor` can flag it). Always exits 0.
