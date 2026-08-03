# me gemini

Gemini CLI integration commands.

## Commands

- [me gemini install](#me-gemini-install) -- register `me` as an MCP server with Gemini CLI
- [me gemini uninstall](#me-gemini-uninstall) -- remove the recorded MCP registration
- [me gemini env-hook](#me-gemini-env-hook) -- internal helper (you never run this directly)

---

## me gemini install

Register `me` as an MCP server with Gemini CLI.

```bash
me gemini install
```

This non-interactive command registers exactly `me mcp`. It does not add hooks,
credentials, capture behavior, or runtime targeting.

## me gemini uninstall

```bash
me gemini uninstall
```

Removes only the registration recorded by `me gemini install`.

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

---

## me gemini env-hook

An internal helper retained for existing integrations. New `me gemini install`
installations do not add this hook.
