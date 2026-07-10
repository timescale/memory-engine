# Changelog

All notable changes to the memory engine are documented here. The client
(`v<x.y.z>`) and server (`server/v<x.y.z>`) release independently but are
versioned in lockstep for coordinated breaking changes.

## Unreleased

### Added
- **`memory.append`** — append text to a memory's content in one atomic
  server-side operation: the existing body is never fetched and rewritten, and
  metadata is never touched. Exposed as the `memory.append` RPC, the
  `me append` / `me memory append` CLI command, and the `me_memory_append` MCP
  tool. Targets a memory by id or `tree/name` path, joins with a configurable
  `--separator` (default `\n\n`, omitted for empty existing content or an
  existing trailing separator), and supports an optional `versionHash`
  optimistic-concurrency guard. Each append carries an operation-scoped
  `idempotencyKey` (generated per invocation) so a retried or raced append
  lands exactly once — reusing a key for a different request is a `CONFLICT`.
  `append` is the one client mutation transport-retried on transient failures,
  made safe by that key. Adds the per-space `append_receipt` table and
  `append_memory` function (space schema bumped to `0.0.7`).

## 0.5.0

Server `server/v0.5.0` · Client `v0.5.0`.

### Added
- **Service accounts** (`principal.kind = 's'`): space-scoped, credential-bearing
  principals for production integrations that shouldn't be tied to a human or an
  agent's owner-clamp.
  - CLI: `me service create | list | rename | delete`, and
    `me apikey create --service <idOrName>` (plus `me apikey list --service`) to
    mint/list service-account keys. Keys come only from `ME_API_KEY` / `--api-key`
    — there is no `--as-service` mode.
  - RPC (user endpoint): `serviceAccount.create | list | rename | delete`;
    `principal.list` accepts kind `s` and `whoami` reports it.
  - Creating a service account also creates a **bound admin group**; its direct
    user members (and space admins) manage the service account's api keys.
  - Access model: service accounts take direct + ordinary-group tree grants with
    **no owner-clamp and no `~` home** — they start with zero tree access until
    explicitly granted. They may be made a direct space admin, but a
    service-account key can never mint keys or run `space.delete`.

### Changed
- **Memory RPC admission is now gated on direct `principal_space` membership**
  rather than a non-empty computed tree-access set. A rostered member with zero
  grants can now authenticate (data is still filtered by tree access); a
  principal with no membership row is rejected regardless of group-staged grants.

### Unchanged
- The `memory.*` data plane is wire-compatible with 0.4.x — search / create /
  get are unaffected.
- `MIN_CLIENT_VERSION` / `MIN_SERVER_VERSION` stay at 0.4.0 (this release is
  additive; older 0.4.0 clients remain compatible).

### Database
- core schema -> 0.0.4, space schema -> 0.0.6 (auth unchanged at 0.0.1).
  Migrations auto-apply on server boot; rolling back to a pre-0.5.0 server image
  is refused by the downgrade guard on core/space.

## 0.4.0

Server `server/v0.4.0` · Client `v0.4.0`.

### Breaking
- **Invitations reworked.** `invite.create` now takes a required non-empty
  `groupIds` and no longer accepts `shareAccess`; `email` is optional (omit it
  for an open shareable link). The result returns a magic-link `token` (the old
  `applied` / `principalId` fields are gone). Invitation responses are reshaped:
  `email` is nullable and `shareAccess` is removed, with new group / link /
  expiry / usage fields.
- New invite lifecycle methods: `invite.pending`, `invite.accept`,
  `invite.decline`, `invite.redeem` (user RPC), and `invite.revokeById`
  (space RPC).
- Admin groups: `group.setIsSpaceAdmin`, `group.create { isSpaceAdmin }`, and
  `groupResponse.isSpaceAdmin`.
- Custom-space provisioning: `space.create { autoGrantHome, defaultGroupName,
  defaultGroupGrants }`, new `space.ensureDefault`, and `memberSpaceResponse`
  gains `autoGrantHome` + `defaultGroup`.
- **Minimum versions raised:** the server requires client >= 0.4.0
  (`MIN_CLIENT_VERSION`) and the client requires server >= 0.4.0
  (`MIN_SERVER_VERSION`). Older CLIs are rejected with
  `CLIENT_VERSION_INCOMPATIBLE` — upgrade required.

### Added
- `me space create` custom-space flags (home grants, default group, god mode).
- Space membership removal: `me space leave`, admin remove-member, and owner
  removal cascading to owned agents.
- Act as an owned agent via `--as-agent` / `ME_AS_AGENT` / `X-Me-As-Agent`.
- `me project init` interactive setup; per-project `.me/config.yaml` routing
  for capture hooks and bulk import sweeps.
- `$prev` / `$next` / `$thread` thread-link meta keys.

### Unchanged
- The `memory.*` data plane is wire-compatible with 0.3.x — search / create /
  get are unaffected.

### Database
- core schema -> 0.0.2, space schema -> 0.0.5. Migrations auto-apply on server
  boot; rolling back to a pre-0.4.0 server image is refused by the downgrade
  guard.
