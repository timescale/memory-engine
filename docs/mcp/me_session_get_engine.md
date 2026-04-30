# me_session_get_engine

Return which Memory Engine this MCP session is currently bound to.

Read-only. Never exposes the API key. Useful before destructive writes to confirm the target engine, or to detect a FRESH (unbound) session that the agent should resolve before proceeding.

## Parameters

None.

## Returns

When the session is bound (the common case):

```json
{
  "bound": true,
  "engine": {
    "slug": "team-connectors-oncall",
    "name": "Team Connectors On-call",
    "orgSlug": "tigerdata",
    "orgName": "Tiger Data"
  }
}
```

When the session was started without a bootstrap key and no [`me_session_use_engine`](me_session_use_engine.md) call has happened yet:

```json
{ "bound": false }
```

| Field | Type | Description |
|-------|------|-------------|
| `bound` | `boolean` | Whether the session has an active engine. If `false`, all `me_memory_*` tools will error until [`me_session_use_engine`](me_session_use_engine.md) is called. |
| `engine.slug` | `string` | Canonical engine identifier. Always present when `bound: true`. |
| `engine.name`, `engine.orgSlug`, `engine.orgName` | `string \| undefined` | Human-readable context. Populated whenever the session was bound through [`me_session_use_engine`](me_session_use_engine.md); may be missing on a session bootstrapped from `--api-key` alone, where only the slug is parseable. |

## Notes

- The engine record is held in memory by the MCP server process. Closing the Claude Code session resets the binding.
- This tool does NOT touch the network or `~/.config/me/credentials.yaml`.
