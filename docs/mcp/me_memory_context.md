# me_memory_context

Inspect the current Memory Engine execution context.

Use this tool when you need to confirm which server, selected space, and principal the MCP server is using, or when you need to choose a readable or writable tree path.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `space` | `string` | varies | Absent in locked mode; required nonempty string in multi-space mode. It selects the same-server space for this call. |

## Returns

```json
{
  "server": "https://api.memory.build",
  "mode": "user",
  "space": {
    "id": "019f...",
    "slug": "6nnv8r3gz9jr",
    "name": "Acme"
  },
  "principal": {
    "id": "019f...",
    "kind": "u",
    "name": "alice@example.com",
    "admin": false
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
| `activeSpace` | `string` | Present only in locked mode: the space slug sent as `X-Me-Space` for every call. |
| `mode` | `string` | `user` or `service-account`. |
| `space` | `object` | Server-confirmed space id, slug, and display name for this call. In multi-space mode, this is the selected context. |
| `principal` | `object` | Principal the memory tools are acting as. `kind` is `u` for user or `s` for service account. |
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
- When project instructions mention a tree layout but the active space may use different grants.

## Notes

- This is a read-only operation.
- The access list is effective access, not just direct grants. It includes access inherited through groups.
- Empty access means the principal is a member of the space but has no readable or writable tree paths.
