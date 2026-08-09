# Changelog

All notable changes to the memory engine are documented here. The client
(`v<x.y.z>`) and server (`server/v<x.y.z>`) release independently but are
versioned in lockstep for coordinated breaking changes.

## 0.7.3

Server `server/v0.7.3` · Client `v0.7.3`.

### Added
- **JSONPath metadata filters.** Search and export now accept a PostgreSQL
  JSONPath predicate (`metaPredicate` in RPC/MCP; `--meta-predicate` in the
  CLI) for queries such as matching array members, nested values, comparisons,
  and existence checks that structured metadata containment cannot express.
- **Composable temporal filters.** Search and export can now combine `before`,
  `after`, `contains`, `overlaps`, and `within` predicates; every supplied
  predicate must match. The CLI exposes `--temporal-before` and
  `--temporal-after` alongside the existing temporal options.

### Fixed
- **Group-name resolution for group administrators.** Group-management commands
  now resolve a group by name through the member-accessible principal lookup,
  rather than requiring the admin-only group listing permission.
- Empty temporal filter objects and empty JSONPath predicates are rejected at
  validation time instead of reaching search as ambiguous filters.

### Changed
- The client now requires server >= 0.7.3 (`MIN_SERVER_VERSION`) because these
  search parameters require server support added in this release.

### Database
- Space schema -> 0.0.8. Search functions gain JSONPath metadata and temporal
  containment parameters. Migrations auto-apply on server boot; rolling back to
  a server older than 0.7.3 is refused by the space-schema downgrade guard.

## 0.7.2

Server `server/v0.7.2` · Client `v0.7.2`.

### Fixed
- **Search deploy fix (the 0.7.1 search-scoring pass reaches production).** 0.7.1
  enabled pgvector HNSW iterative scan by setting `hnsw.iterative_scan` via a
  function `SET` clause on `search_memory`. That clause is validated at
  `CREATE FUNCTION` time, and on a boot re-migration of an *existing* space the
  vector index isn't rebuilt, so pgvector isn't loaded on that connection and the
  parameter is an unrecognized placeholder — which the non-superuser application
  role is denied (`SQLSTATE 42501`), aborting server startup and rolling back the
  deploy. The setting is now applied at query time inside `search_memory` as a
  transaction-local `set_config`, which the app role is permitted to do and which
  still enables strict-order iterative scan for filtered semantic search. No
  behavior change for callers; this is what lets the 0.7.1 changes below actually
  deploy.

## 0.7.1

Server `server/v0.7.1` · Client `v0.7.1`.

A search-correctness pass: the three search modes now score and filter results
correctly. See the new [Searching Memories](https://docs.memory.build/search)
guide.

### Fixed
- **Semantic search `score` is now cosine similarity.** Results previously
  reported a negative cosine-*distance* value (`similarity - 1`, in `[-2, 0]`);
  they now report true cosine **similarity** (`1 - distance`, in `[-1, 1]`,
  higher = more similar), matching the `semanticThreshold` scale. Result
  **ordering is unchanged** — only the returned number is corrected. Integrators
  that compared the raw `score` against a hard-coded value should re-check it.
- **Fulltext and hybrid search no longer return zero-relevance rows.** A keyword
  (BM25) query whose matches were fewer than the limit used to backfill the
  result with rows that contained **none** of the query terms (score `0.000`),
  and in hybrid search those junk rows still received a small fused score.
  Search now returns only genuine term matches.
- **Filtered semantic recall.** A semantic query combined with access/tree/meta/
  temporal filters or `semanticThreshold` could return fewer matches than
  requested, because filtering pruned the vector index's initial candidate
  window. Search now keeps scanning until it has filled the limit (up to an
  internal work cap).

### Changed
- Documented the **mode-dependent `score`** across the CLI, the MCP tool, and the
  docs: semantic = cosine similarity `[-1, 1]`; fulltext = a positive,
  unnormalized BM25 score (`> 0`); hybrid = a fused Reciprocal Rank Fusion
  score; filter-only = an unranked `-1` sentinel. Scores are comparable only
  within a single result set.

### Database
- The space search SQL functions are updated in place (semantic score contract,
  HNSW iterative scan, BM25 `> 0` filter). No schema version change — the
  idempotent search migration re-applies on deploy.

## 0.7.0

Server `server/v0.7.0` · Client `v0.7.0`.

### Breaking
- **Agent principals removed.** The `agent` principal kind and every
  act-as-agent flow are gone: `--as-agent` / `ME_AS_AGENT` /
  `X-Me-As-Agent`, owned-agent creation, and agent-scoped identity. Use a
  **service account** (or a personal access token) for automated access
  instead.
- **Repository project configuration removed (hard cut).** `.me/config.yaml`,
  `ME_CONFIG_DIR` / `--config-dir`, `me project init`, `me project ci`, and
  `me import ci` no longer exist. Harness behavior is now machine-local policy
  configured with `me init`, and CI setup is `me ci install`. Cloning a repo no
  longer changes what Memory Engine does on your machine.
- **Gemini harness support removed.** Only Claude Code, OpenCode, and Codex CLI
  are supported harnesses.
- **Minimum server version raised:** the client now requires server >= 0.7.0
  (`MIN_SERVER_VERSION`) so a new client cannot request restricted API-key
  access from a server too old to enforce the scope. `MIN_CLIENT_VERSION`
  stays at 0.4.0 — the `memory.*` data plane (CRUD + search) is unchanged, so
  older clients keep working for ordinary user and service-account access.
  Removed agent flows (`--as-agent`, `agent.*`) are the exception: an old
  client that used them silently loses that behavior against a 0.7.0 server.

### Added
- **Restricted API keys.** `me apikey create` gains `--allow <scope>` (space or
  `space:path:r|w|o` tree ceiling), `--space-admin <space>`, and `--ttl`.
  Restricted keys are capped to their declared spaces and dynamically clamped to
  the holder's live authority; the server enforces the scope. Key metadata now
  tracks a day-resolution last-used date.
- **Harness integrations rework.** `me install` / `me uninstall` register
  dormant, user-global integrations for Claude Code, OpenCode, and Codex CLI.
  `me init` (quick setup, plus `--verbose` and `--defaults` wizards) writes
  machine-local policy in `~/.config/me/config.yaml` with independent MCP,
  capture, and harness-shell CLI surfaces. `me doctor` explains the effective
  policy for a directory. See the new
  [Harness Integrations](https://docs.memory.build/harness-integrations) guide.
- **`me ci install`.** Generates a GitHub Actions workflow that imports git
  history and Markdown docs, optionally provisioning a service account and
  placing its key. The workflow runs `me import git` and `me import docs`
  directly, restricts itself to `contents: read`, and checks out with
  `persist-credentials: false`.
- **Multi-space MCP.** A manual `me mcp` without a pinned space runs in
  multi-space mode: `me_space_list` is available and memory tools take a
  `space` argument. An explicit `--space` / `ME_SPACE` still locks the server.
- **Memory field projection.** `me memory get` / `me memory search` accept
  `--select`, and the MCP read tools accept `select` (plus `format`:
  `yaml` default, or `json` / `compact`) to return only the requested fields
  and content slices.
- **Gateway-routed embeddings** via the `EMBEDDING_MODEL` environment variable.

### Changed
- OAuth token refresh is hardened: refreshes are serialized across processes
  with lock-ownership checks, and refresh requests carry validated
  client-identity headers for telemetry.
- Tree-access grants resolve in a deterministic order.

### Fixed
- Exact `~` tree-path filters now build a valid lquery.
- npm release tarballs are packed by bun so `workspace:*` dependencies resolve.

### Database
- core schema 0.0.4 -> 0.0.6 (API-key last-used tracking, then the scoped
  API-key access model). auth stays 0.0.2 and space stays 0.0.6. Migrations
  auto-apply on server boot; rolling back to a pre-0.7.0 server image is refused
  by the downgrade guard on core.

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
- MCP memory read tools now return YAML by default; pass `format: "json"` or
  `format: "compact"` to receive compact JSON text.

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
