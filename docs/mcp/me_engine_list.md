# me_engine_list

List engines this identity has access to across all orgs.

Read-only. Uses the session token from `~/.config/me/credentials.yaml`, not the active engine's API key, so it works regardless of which engine is currently bound (or even when none is bound). Use as the first step of an engine-switching flow: enumerate, then call [`me_session_use_engine`](me_session_use_engine.md) with the chosen slug.

Errors with a "run `me login`" hint if no session token is available.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filter` | `string \| null` | no | Substring filter on engine name or slug (case-insensitive). Useful when the user typed a partial name. |
| `org` | `string \| null` | no | Restrict to a single org by slug, name, or ID. |
| `has_local_key` | `boolean \| null` | no | If `true`, only return engines for which a local API key is already stored (i.e. ready to bind without provisioning). |

## Returns

```json
{
  "engines": [
    {
      "id": "0194a000-0001-7000-8000-000000000001",
      "slug": "team-connectors-oncall",
      "name": "Team Connectors On-call",
      "status": "active",
      "org": {
        "id": "0194a000-0002-7000-8000-000000000002",
        "slug": "tigerdata",
        "name": "Tiger Data"
      },
      "has_local_key": true,
      "active": false
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `engines` | `array` | Engine records, each with org context, local-key availability, and an `active` flag (true if this engine is the one currently bound to the session). |

## Examples

### List everything

```json
{}
```

### Filter by partial name

```json
{ "filter": "oncall" }
```

### Only engines that are ready to bind without provisioning

```json
{ "has_local_key": true }
```

## Notes

- This tool does NOT mutate any state. Switching the bound engine is done via [`me_session_use_engine`](me_session_use_engine.md).
- `has_local_key: false` means the caller would need to run `me engine use <slug>` outside Claude Code (or use a dedicated provisioning tool, when available) before [`me_session_use_engine`](me_session_use_engine.md) will succeed.
