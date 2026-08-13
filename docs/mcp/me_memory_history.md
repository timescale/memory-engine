# me_memory_history

Read the append-only audit log of memory mutations.

Every insert, update, and delete is recorded as one immutable event. Each event carries the actor, an app-level cause, the physical operation, an `operationId` shared across a bulk statement, and a full snapshot of the resulting (or, for deletes, removed) state. Use it to answer "who changed this memory, when, and how" — including "who deleted it".

Access is enforced per event by read access to that event's own tree, so the history of a memory that moved between trees may appear partial to a caller who lacks read on some of its historical trees. Deleted memories remain visible here — query them by `memoryId`.

Pass at least one scope: `memoryId`, `path`, `tree`, `operationId`, or `since`. `operation` narrows within a scope.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `space` | `string` | varies | Absent in locked mode; required nonempty string in multi-space mode. It selects the same-server space for this call. |
| `memoryId` | `string \| null` | no | UUID of a memory; returns just that memory's history. Works after deletion. |
| `path` | `string \| null` | no | `tree/name` path of a memory; resolved live, else via the audit log, so a deleted memory's history is reachable by path. |
| `tree` | `string \| null` | no | Subtree path filter; returns events at or under this path. |
| `operation` | `"insert" \| "update" \| "delete" \| null` | no | Filter by physical operation. |
| `operationId` | `string \| null` | no | Return all events sharing one bulk operation id (e.g. every row of a bulk delete or move). |
| `since` | `string \| null` | no | Only events at or after this time (ISO 8601). A `since` alone drives a space-wide activity feed. |
| `until` | `string \| null` | no | Only events strictly before this time (ISO 8601). |
| `cursor` | `string \| null` | no | Keyset cursor from a prior response's `nextCursor`; fetches the next page. |
| `limit` | `number \| null` | no | Maximum events (`0` = default 20, max 1000). |
| `order` | `"asc" \| "desc" \| null` | no | Sort by event time. Default `desc` (newest first). |
| `select` | `string[] \| null` | no | Snapshot fields to return per event (e.g. `content:200`); the audit envelope is always included. |
| `format` | `"yaml" \| "json" \| "compact" \| null` | no | Text serialization format. Omit or pass `null` for YAML; `json` and `compact` both return compact JSON. |

At least one of `memoryId`, `path`, `tree`, `operationId`, or `since` is required; a bare unbounded scan is rejected.

## Returns

The tool returns YAML by default. The JSON below illustrates the result shape.

```json
{
  "events": [
    {
      "eventId": "0194a000-0002-7000-8000-000000000009",
      "at": "2025-04-15T12:05:00Z",
      "operation": "delete",
      "operationId": "0194a000-0002-7000-8000-00000000000a",
      "cause": "delete",
      "actor": {
        "principalId": "0194a000-0000-7000-8000-000000000003",
        "principalName": "alice@example.com",
        "apiKeyId": null,
        "apiKeyName": null
      },
      "memoryId": "0194a000-0001-7000-8000-000000000001",
      "tree": "/share/auth",
      "name": "jwt-rotation",
      "meta": {},
      "temporal": null,
      "content": "Rotate signing keys every 90 days.",
      "version": 2,
      "versionHash": "5f3e9c2a8b1d4f7e0c3a6b9d2e5f8c1a"
    }
  ],
  "limit": 20,
  "nextCursor": null
}
```

`nextCursor` is a keyset cursor: non-null when a full page was returned (more events may exist). Pass it back as `cursor` to fetch the next page.

| Field | Type | Description |
|-------|------|-------------|
| `eventId` | `string` | UUIDv7 identifier of the event. |
| `at` | `string` | ISO 8601 timestamp of when the event was recorded. |
| `operation` | `string` | Physical operation: `insert`, `update`, or `delete`. |
| `operationId` | `string` | Shared across every row of one statement — correlates bulk operations. |
| `cause` | `string \| null` | App-level intent (e.g. `create`, `update`, `delete`, `move`, `delete_tree`); `null` for direct/unattributed mutations. |
| `actor` | `object` | Who performed the mutation: `principalId`, `principalName`, `apiKeyId`, `apiKeyName`. All `null` for unattributed mutations; `apiKey*` are `null` for session-authed writes. |
| `memoryId` | `string` | UUID of the memory the event belongs to. |
| `tree` | `string` | Tree path at the time of the event (canonical `/`-form). |
| `name` | `string \| null` | Leaf name at the time of the event, or `null`. |
| `meta` | `object` | Metadata snapshot. |
| `temporal` | `object \| null` | Temporal range snapshot with `start`/`end`, or `null`. |
| `content` | `string` | Content snapshot of the resulting (or, for deletes, removed) state. |
| `version` | `integer` | Logical-payload version of the snapshot. |
| `versionHash` | `string` | 32-char md5 hex of the snapshot. |

## Example

The history of a single memory, including who deleted it:

```json
{
  "memoryId": "0194a000-0001-7000-8000-000000000001"
}
```

Every row of one bulk delete:

```json
{
  "operationId": "0194a000-0002-7000-8000-00000000000a"
}
```

## Notes

- The audit log is append-only; there is no way to modify or remove events through the API. Events are retained for 30 days.
- History is gated per event by read access to that event's tree, so a moved memory's history can look partial. Deleted memories stay readable by `memoryId` or `path`.
- Omit `select` for the full event. Selecting only trims the snapshot fields (`content`, `meta`, `tree`, `name`, `temporal`, `version`, `versionHash`); the audit envelope (`eventId`, `at`, `operation`, `operationId`, `cause`, `actor`, `memoryId`) is always present. `content:N`, `content:M:N`, and `content:M:` select UTF-16 code-unit ranges and include the full UTF-16 `contentLength`.
