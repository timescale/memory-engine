# me_session_use_engine

Bind this MCP session to a specific Memory Engine.

All subsequent `me_memory_*` tool calls in this session will read from and write to the chosen engine. Per-session, in-memory only. Does NOT modify `~/.config/me/credentials.yaml` or affect other Claude Code sessions or other MCP clients. Switching back to a previously-used engine is free; the API key is cached for the lifetime of this MCP process.

Use this when you want to scope memory writes to a team-shared engine (e.g. an investigation knowledge base) without polluting a personal default engine.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `engine` | `string` | yes | Engine slug, name, or ID. Combine with `org` for disambiguation. |
| `org` | `string \| null` | no | Optional org disambiguator: org slug, name, or ID. Omit unless the engine is ambiguous. |
| `validate` | `boolean \| null` | no | If `true` (default), round-trip a cheap call to verify the stored key works before committing the switch. Set to `false` to skip the validation request. |

## Returns

```json
{
  "engine": {
    "id": "0194a000-0001-7000-8000-000000000001",
    "slug": "team-connectors-oncall",
    "name": "Team Connectors On-call",
    "org": { "slug": "tigerdata", "name": "Tiger Data" }
  },
  "previous_engine": "personal-gonzalo",
  "validated": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `engine` | `object` | The newly-bound engine record. |
| `previous_engine` | `string \| null` | The slug of the engine this session was bound to before the call, or `null` if the session was FRESH. |
| `validated` | `boolean` | Whether the server round-trip happened this call. False when `validate: false` was passed, or when an EngineClient for the target slug was already cached from an earlier bind in this session. |

## Errors

- `No engine matches '<arg>'…`. Call [`me_engine_list`](me_engine_list.md) to see what's available.
- `Ambiguous engine '<arg>'…`. Pass `org` to disambiguate, or use the engine ID.
- `No local API key for engine '<slug>'…`. Call [`me_session_provision_engine`](me_session_provision_engine.md) with the same engine arg to mint one, then retry.

## Notes

- Calling this tool is the canonical way to fulfil a `/use-memory <engine>` request from the user.
- Closing the Claude Code session resets the binding; no cleanup is required.
- This tool does NOT mutate any persistent state. To make an engine the default for new sessions, use the `me engine use <slug>` CLI command instead.
