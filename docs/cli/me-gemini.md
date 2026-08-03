# me gemini

Gemini CLI integration commands.

## Commands

- [me gemini install](#me-gemini-install) -- install dormant Gemini plumbing
- [me gemini uninstall](#me-gemini-uninstall) -- remove recorded Gemini plumbing
- [me gemini env-hook](#me-gemini-env-hook) -- internal helper (you never run this directly)

---

## me gemini install

Register `me` as an MCP server with Gemini CLI.

```bash
me gemini install
```

This non-interactive command registers exactly `me mcp` and installs a
user-global `BeforeTool` hook. The hook injects only `AI_AGENT=gemini` and
`ME_PROJECT_DIR`; it does not store credentials, select runtime targeting, or
enable capture. MCP directory context propagation has not been manually
validated, so per-directory MCP behavior is not guaranteed.

## me gemini uninstall

```bash
me gemini uninstall
```

Removes only the MCP registration and `BeforeTool` hook recorded by
`me gemini install`.

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

---

## me gemini env-hook

An internal helper used when a Gemini `BeforeTool` hook is configured. It fails
open for unknown payloads and logs only their sanitized shape.
