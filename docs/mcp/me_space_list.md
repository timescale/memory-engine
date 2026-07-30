# me_space_list

List spaces available to the credential used by this MCP server.

This tool is available in **multi-space** mode. It is absent when the server is
locked with `--space` or `ME_SPACE`.

## Parameters

This tool takes no parameters.

## Returns

```json
{
  "spaces": [
    {
      "slug": "6nnv8r3gz9jr",
      "name": "Acme"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `slug` | `string` | The space slug to pass as `space` to a memory tool. |
| `name` | `string` | The space display name. |

## Notes

- The list is filtered by the credential's authorization. Restricted API keys
  return only their declared spaces.
- Supplying a returned slug to a memory tool selects that space for that call;
  it does not grant access.
