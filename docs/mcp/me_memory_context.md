# me_memory_context

Inspect the current Memory Engine execution context.

Use this tool when you need to confirm which server, space, and principal the MCP server is using, or when you need to choose a readable or writable tree path.

## Parameters

This tool takes no parameters.

## Returns

```json
{
  "server": "https://api.memory.build",
  "activeSpace": "6nnv8r3gz9jr",
  "asAgentConfigured": "coder",
  "mode": "act-as-agent",
  "space": {
    "id": "019f...",
    "slug": "6nnv8r3gz9jr",
    "name": "Acme"
  },
  "principal": {
    "id": "019f...",
    "kind": "a",
    "name": "coder",
    "ownerId": "019d...",
    "admin": false
  },
  "authenticatedAs": {
    "id": "019d...",
    "kind": "u",
    "name": "alice@example.com"
  },
  "access": [
    {
      "treePath": "/share/projects",
      "access": 2,
      "accessName": "write"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `server` | `string` | Server URL configured for this MCP server. |
| `activeSpace` | `string` | Active space slug sent as `X-Me-Space`. |
| `asAgentConfigured` | `string \| null` | Configured act-as-agent value, if the MCP server is sending one. |
| `mode` | `string` | `user`, `agent`, `service-account`, or `act-as-agent`. |
| `space` | `object` | Active space id, slug, and display name. |
| `principal` | `object` | Principal the memory tools are acting as. `kind` is `u` for user, `a` for agent, or `s` for service account. |
| `authenticatedAs` | `object \| null` | User identity behind act-as-agent mode. Null for direct user, agent-key, and service-account-key calls. |
| `access` | `array` | Effective tree access paths for the acting principal. |

Each access row contains:

| Field | Type | Description |
|-------|------|-------------|
| `treePath` | `string` | Display path such as `/share`, `~/notes`, or `/`. |
| `access` | `integer` | Numeric access level: 1 read, 2 write, 3 owner. |
| `accessName` | `string` | `read`, `write`, or `owner`. |

## When To Use

- Before storing a memory when the writable tree is unclear.
- When `me_memory_search` returns fewer results than expected.
- When create, update, move, or delete fails because the chosen tree is not writable.
- When agent instructions mention a tree layout but the active space may use different grants.

## Notes

- This is a read-only operation.
- The access list is effective access, not just direct grants. It includes access inherited through groups and agent access after owner clamping.
- Empty access means the principal is a member of the space but has no readable or writable tree paths.
