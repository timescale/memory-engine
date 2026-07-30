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
| `--api-key <key>` | API key for a headless install. Default: the MCP server uses your `me login` session, resolved at runtime. |
| `--space <slug>` | Lock MCP to this space. Without it, MCP is multi-space unless `ME_SPACE` is set. |
| `--server <url>` | Server URL to embed in the MCP config. |
| `-s, --scope <scope>` | Gemini CLI config scope: `user` or `project`. Default: `user`. |

By default only the server URL is baked into the config: at runtime `me mcp` uses your `me login` session (resolved from the OS keychain / `~/.config/me` each run, so it survives re-login). MCP is multi-space unless the generated command includes `--space` or its environment sets `ME_SPACE`: agents call `me_space_list`, then pass `space` to every memory tool. Your active space does not select an MCP space. Pass `--space` to lock the MCP tools to one space. Pass `--api-key` for a headless install that cannot reach your keychain; it may also run multi-space. For least privilege, mint a restricted PAT or service-account key with `me apikey create --allow <space>:<path>:<r|w|o>`; a pinned space must be declared by that key.

`me gemini install` also adds a small hook to `~/.gemini/settings.json` so that a plain `me` call from Gemini CLI's shell tool can discover the active project after a directory change. Re-running install is safe and leaves any other hooks you've configured untouched.

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

---

## me gemini env-hook

An internal helper that Gemini CLI invokes automatically through the hook `me gemini install` adds. It makes a plain `me` call from Gemini CLI's shell tool resolve the right project. **You never run this by hand**, and it's designed to fail open — if it can't recognize a command it does nothing, so your commands always run.
