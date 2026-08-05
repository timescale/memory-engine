# me_memory_get

Retrieve a single memory by its ID.

Returns the full memory including content, tree, name, meta, temporal, and embedding status. Use after search to get full details, or before update to see current state. To fetch a named memory by its `tree/name` path instead, use [me_memory_get_by_path](me_memory_get_by_path.md).

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `space` | `string` | varies | Absent in locked mode; required nonempty string in multi-space mode. It selects the same-server space for this call. |
| `id` | `string` | yes | The UUID of the memory to retrieve. |
| `select` | `string[] \| null` | no | Fields to present. Omit or pass `null` for the complete memory. Supports response fields, `meta.keyName`, and content slices. |
| `format` | `"yaml" \| "json" \| "compact" \| null` | no | Text serialization format. Omit or pass `null` for YAML; `json` and `compact` both return compact JSON. |

## Returns

The tool returns YAML by default. The JSON below illustrates the complete
memory-object shape; pass `format: "json"` or `format: "compact"` for compact
JSON text.

```json
{
  "id": "0194a000-0001-7000-8000-000000000001",
  "content": "PostgreSQL 18 supports native UUID v7 generation.",
  "meta": { "topic": "database" },
  "tree": "/notes/postgres",
  "name": "uuidv7",
  "temporal": null,
  "version": 1,
  "versionHash": "5f3e9c2a8b1d4f7e0c3a6b9d2e5f8c1a",
  "hasEmbedding": true,
  "createdAt": "2025-04-15T12:00:00Z",
  "createdBy": null,
  "updatedAt": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | UUIDv7 identifier. |
| `content` | `string` | The memory content. |
| `meta` | `object` | Metadata key-value pairs (empty `{}` if none). |
| `tree` | `string` | Tree path (canonical `/`-form; `/` if root). |
| `name` | `string \| null` | The leaf name, or `null` if unnamed. |
| `temporal` | `object \| null` | Time range with `start` and `end`, or `null`. |
| `version` | `integer` | Monotonically increasing logical-payload version. |
| `versionHash` | `string` | 32-char md5 hex over `tree`, `name`, `meta`, `temporal`, `content`. Pass back as `version_hash` to `me_memory_update` for optimistic concurrency control. |
| `hasEmbedding` | `boolean` | Whether a vector embedding has been computed. |
| `createdAt` | `string` | ISO 8601 creation timestamp. |
| `createdBy` | `null` | Reserved field; per-memory creators are not currently tracked. |
| `updatedAt` | `string \| null` | ISO 8601 timestamp of last update, or `null`. |

## Example

```json
{
  "id": "0194a000-0001-7000-8000-000000000001"
}
```

## Notes

- Returns an error if the memory does not exist or the caller lacks access.
- Omit `select` or pass `null` to receive the complete memory object. An empty selection or multiple distinct content slices are invalid. Selectors use camelCase response names. The complete suffix after `meta.` is the metadata key, so `meta.$thread` and punctuated keys are supported. `content:N`, `content:M:N`, and `content:M:` select UTF-16 code-unit ranges and include the full UTF-16 `contentLength`.
- Useful for fetching the current state before performing an update. The returned `versionHash` is the value to pass back as `version_hash` to `me_memory_update`.
