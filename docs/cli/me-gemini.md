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

This non-interactive command registers exactly `me mcp`. It does not add
credentials or runtime targeting. Gemini's user-global dormant `BeforeTool`
adapter is wired by the harness integration installer; it injects only
`AI_AGENT=gemini` and `ME_PROJECT_DIR` for `run_shell_command` calls.

It does not write project or checkout configuration, prompt for configuration,
store credentials, select a server or space, or enable capture. MCP directory
context propagation has not been manually validated, so per-directory MCP
behavior is not guaranteed.

## me gemini uninstall

```bash
me gemini uninstall
```

Removes only the registration recorded by `me gemini install`. The harness
integration installer removes its recorded `BeforeTool` hook while preserving
unrelated Gemini settings and hooks.

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

---

## me gemini env-hook

An internal helper invoked by the user-global `BeforeTool` hook. It fails open
for unknown payloads and logs only their sanitized shape.
