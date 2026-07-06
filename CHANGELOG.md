# Changelog

All notable changes to the memory engine are documented here. The client
(`v<x.y.z>`) and server (`server/v<x.y.z>`) release independently but are
versioned in lockstep for coordinated breaking changes.

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
