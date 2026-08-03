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

This non-interactive command installs user-global Gemini CLI plumbing only:

- An MCP server registration with the exact command `me mcp`.
- A dormant `BeforeTool` hook for `run_shell_command`. It injects only
  `AI_AGENT=gemini` and `ME_PROJECT_DIR` into shell commands.

It does not write project or checkout configuration, prompt for configuration,
store credentials, select a server or space, or enable capture. MCP directory
context propagation has not been manually validated, so per-directory MCP
behavior is not guaranteed.

## me gemini uninstall

```bash
me gemini uninstall
```

Removes only the user-global MCP registration and `BeforeTool` hook recorded by
`me gemini install`; unrelated Gemini settings and hooks are preserved.

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

---

## me gemini env-hook

An internal helper invoked by the user-global `BeforeTool` hook. It fails open
for unknown payloads and logs only their sanitized shape.
