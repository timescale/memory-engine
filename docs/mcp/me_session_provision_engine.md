# me_session_provision_engine

Mint a fresh API key for a Memory Engine, persist it locally, and bind this MCP session to that engine.

Use this when `me_session_use_engine` errors with `No local API key for engine '<slug>'`. The tool calls `accounts.engine.setupAccess` against the server using the session token from `~/.config/me/credentials.yaml`, writes the returned key under `engines.<slug>.api_key`, and updates the per-session binding so subsequent `me_memory_*` calls hit the new engine.

Idempotent: if a key already exists for the target engine, no `setupAccess` call is made; the session is bound using the existing key.

Persistent state effect: writes one new entry under `engines.<slug>.api_key`. Does NOT change `active_engine`; the engine the next `me` CLI invocation treats as default is unaffected.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `engine` | `string` | yes | Engine slug, name, or ID. Combine with `org` for disambiguation. |
| `org` | `string \| null` | no | Optional org disambiguator: org slug, name, or ID. Omit unless the engine is ambiguous. |

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
  "provisioned": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `engine` | `object` | The engine the session is now bound to. |
| `previous_engine` | `string \| null` | The slug of the engine this session was bound to before the call, or `null` if the session was FRESH. |
| `provisioned` | `boolean` | `true` if a new API key was minted and stored. `false` if a key for this engine already existed and was reused. |

## Errors

- `Not logged in: no session token in ~/.config/me/credentials.yaml`. Run `me login` outside the agent, then retry.
- `No engine matches '<arg>'…`. Call [`me_engine_list`](me_engine_list.md) to see what's available.
- `Ambiguous engine '<arg>'…`. Pass `org` to disambiguate, or use the engine ID.
- Server-side authorization failures from `setupAccess` (for example, the user is not a member of the engine's org) are surfaced unchanged.

## Notes

- Pair with [`me_session_use_engine`](me_session_use_engine.md): provision once per engine per machine, then `use` to switch back and forth in-session.
- Closing the Claude Code session does not undo the credential write. The minted key persists in `credentials.yaml` and is reusable by future `me` CLI invocations and MCP sessions.
- The agent never sees the raw API key; it is written directly to disk by the MCP server.
