# Changelog

All notable changes to the memory engine are documented here. The client
(`v<x.y.z>`) and server (`server/v<x.y.z>`) release independently but are
versioned in lockstep for coordinated breaking changes.

## 0.6.2

Server `server/v0.6.2` · Client `v0.6.2`.

### Added
- **Member-visible space roster:** `space.listMembers` and `me space members`
  let any space member list user, agent, and service-account members without
  exposing admin-only roster metadata or groups.
- **Hosted web UI dark mode** with a pre-paint theme initializer, persisted theme
  selection, refreshed icons, and a favicon.
- **Project documentation** covering repository memory trees, project setup, and
  grant authority rules.

### Changed
- Web UI controls and dialogs were refined for the new theme system, including a
  spinning refresh action and small visual fixes across search, editor, account,
  toast, and invite views.
- Harness and project-config documentation was updated to match the current
  Claude, MCP, opencode, and project workflows.

### Unchanged
- `MIN_CLIENT_VERSION` stays at 0.4.0 and `MIN_SERVER_VERSION` stays at 0.6.0.
- No database schema version changes.

## 0.6.1

Server `server/v0.6.1` · Client `v0.6.1`.

### Fixed
- **OpenCode import support** for SQLite-backed sessions, including safer import
  tree handling, portable generated import workflows, best-effort hook
  resolution, and absolute home thread links.
- **Default-agent setup** now validates stale configured agents and reports the
  adopted default agent name more clearly.
- **Hosted invite links** now route through the SPA fallback, so invite URLs open
  correctly in the hosted web UI.
- Memory import GitHub Actions setup now uses a restricted workflow scope and
  fails faster on installer download errors.

### Changed
- `MIN_SERVER_VERSION` was raised to 0.6.0 for the client release.

### Database
- No schema version changes.

## 0.6.0

Server `server/v0.6.0` · Client `v0.6.0`.

### Breaking
- **Removed `me import git-hook`.** Use the current project import workflow
  instead (`me project ci` / `me import ci`).
- **Minimum server version raised:** the client requires server >= 0.6.0
  (`MIN_SERVER_VERSION`) because the new login and project-import workflows rely
  on server support added in this release.

### Added
- **Device-flow login** for headless environments: `me login --device` now shows
  a browser approval code and signs the CLI in through the web `/device` page.
- **Account switching** with `me login --switch` for replacing the active CLI
  session deliberately.
- **Project CI import setup** via `me project ci`, including workflow-only setup,
  service-account/key-placement hardening, and CI-friendly `me import ci`
  orchestration.
- **Effective access visibility** in the memory context, including caller-aware
  rendering of `~`, root display, and target access lookups.

### Changed
- Server auth handling is stricter for bearer-session requests: signed session
  bearers are required, cookie fallback is blocked for failed bearer lookups, and
  device-code issuance is rate-limited.
- Device-flow UX preserves the entered code and email across sign-in and approval
  errors.

### Unchanged
- `MIN_CLIENT_VERSION` stays at 0.4.0; the 0.6.0 server still accepts compatible
  older clients.

### Database
- auth schema -> 0.0.2 (adds the better-auth device-code table), core schema
  remains 0.0.4, and space schema remains 0.0.6. Migrations auto-apply on server
  boot; rolling back to a pre-0.6.0 server image is refused by the downgrade
  guard on auth.

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
