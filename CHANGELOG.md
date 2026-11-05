# Changelog

All notable changes to the memory engine are documented here. The client
(`v<x.y.z>`) and server (`server/v<x.y.z>`) release independently but are
versioned in lockstep for coordinated breaking changes.

## 0.9.5 (server)

Server `server/v0.9.5` · Client unchanged (`v0.9.2`).

### Fixed
- **Request telemetry no longer records invite credentials.** Logged paths
  redact invite tokens, including percent-encoded forms. Segments that cannot be
  percent-decoded are redacted in full rather than recorded unchanged.
- Logged URLs omit query strings and fragments, which can carry OAuth codes,
  state, or callback links. The original request remains unchanged for routing,
  sign-in, and invite redemption.
- Existing telemetry is not rewritten and exposed invites are not revoked by
  this release. Check previously exposed invites and revoke any still valid.

### Compatibility and database
- No client release, compatibility-minimum changes, or new schema migrations.

## 0.9.2 (client) / 0.9.4 (server)

Server `server/v0.9.4` · Client `v0.9.2`.

### Fixed
- **Every new CLI authorization requires explicit browser approval.** Existing
  browser sessions, previous consent grants, and older CLI versions cannot
  silently authorize a new local program. The approval page shows the account,
  permissions, and exact callback address. Invalid or expired requests, account
  changes, and cross-origin approval submissions are rejected.
- **The CLI displays its actual callback address before opening the browser.**
  Compare it with the approval page before authorizing. JSON and YAML modes emit
  `authorization_url` and `redirect_uri` on stderr, including with `--no-browser`,
  while stdout remains reserved for the final result.
- **MCP memory exports cannot overwrite executable or non-regular files.**
  File destinations must end in `.md`, `.json`, `.yaml`, or `.yml`. New files
  have non-executable permissions. Rejected executable overwrites preserve the
  original contents and permissions, including during Markdown directory export.

### Compatibility and database
- Auth migration 009 advances `AUTH_SCHEMA_VERSION` to `0.0.4` and sets the
  existing CLI client's `skip_consent` to false. Server-side enforcement still
  requires approval when previous consent or cached client metadata exists.
- Existing sessions, access tokens, refresh tokens, device login, and API keys
  remain usable. No compatibility-minimum changes.
- Deploy the approval UI and server enforcement together to every API replica.
  An image-only rollback to a server expecting auth schema `0.0.3` is blocked;
  prefer a forward fix rather than restoring a server without approval enforcement.

## 0.9.3 (server)

Server `server/v0.9.3` · Client unchanged (`v0.9.1`).

### Changed
- **better-auth and `@better-auth/oauth-provider` 1.6 → 1.7.14.** Clears the
  open advisories against 1.6 (none of which were reachable in this
  configuration except the device-approval one, already mitigated in 0.9.2).
  Access tokens the provider marks `revoked` (session end, back-channel
  logout) no longer authenticate before they expire. The OAuth callback now
  reports hook failures as `error=<code>&error_description=<message>`; the
  sign-in page shows the description.

### Fixed
- The `/device` and invite landing pages show the sign-in card to a signed-out
  visitor instead of "Couldn't reach Memory Engine".

### Compatibility and database
- Auth schema migration 008 (`AUTH_SCHEMA_VERSION` 0.0.3), additive: new
  nullable columns on the jwks and OAuth tables, three new unused OAuth
  tables, and the seeded `me-cli` client updated to
  `token_endpoint_auth_method = 'none'` / `application_type = 'native'`
  (how 1.7 recognises a public native client). Runs on server start.
- Existing sessions, CLI tokens, refresh tokens, and API keys keep working.
  A social sign-in or device code in flight during the rollout fails once
  and is retried.
- Rolling back to a pre-1.7 image requires resetting the auth schema version
  stamp first; see `design/authentication.md`, "Rolling back".
- No client release and no compatibility-minimum change.

## 0.9.1 (client) / 0.9.2 (server)

Server `server/v0.9.2` · Client `v0.9.1`.

A security release following an internal audit. No wire-protocol or schema
changes; both sides remain compatible with 0.9.0.

### Fixed
- **`me serve` only proxies requests from its own origin.** The local proxy
  injects the user's session token into upstream calls. It now requires the
  `Host` header to name the bound listener, a browser `Origin` /
  `Sec-Fetch-Site` to be same-origin, and RPC bodies to be `application/json`,
  so a web page in another tab (or a DNS-rebinding host) can no longer send
  RPCs as the user. `--host` on a non-loopback address prints a warning.
- **MCP `me_memory_export` / `me_memory_import` stay inside the working
  directory.** File paths are resolved under `process.cwd()` after following
  symlinks, dotfile and dot-directory components are refused, and export will
  not replace an existing file unless `overwrite: true`. Export is now
  annotated `destructiveHint: true`.
- **Restricted API keys cannot manage the space.** A key minted with
  `--allow` (including `--space-admin`) now gets `FORBIDDEN` on
  `group.*` mutations, `group.listMembers`, `grant.*`,
  `principal.add` / `remove`, `invite.*`, and `access.effective` for any
  principal other than itself. Previously a restricted key held by a group
  admin could add members to that group and so widen their grants past the
  key's declared ceiling. Read-only lookups (`principal.list/resolve/lookup`,
  `group.list/listForMember`, `space.listMembers`) are unaffected.
- **Device login requires typing the code.** The `/device` page no longer
  reads `?user_code=` from the URL or pre-fills the code, and the approve
  screen warns that approving a code someone else sent you hands them your
  account. `me login --device` prints the bare URL and the code instead of a
  pre-filled link.
- `/ready` returns `checks.db: "error"` instead of the database driver's
  message; the detail goes to the `Readiness check failed` log record.

### Changed
- CLI: `@modelcontextprotocol/sdk` 1.29 → 1.32 (clears three advisories).
- Build: `bun install` is frozen-lockfile everywhere via `bunfig.toml`.
  Intentional dependency changes use `./bun install --config=/dev/null`.
- CI makes no external API calls; the e2e suite uses a local fake embedding
  server, and the live OpenAI suite is opt-in (`RUN_OPENAI_INTEGRATION=1`).
  Workflows run with a read-only `GITHUB_TOKEN`.

### Compatibility and database
- No compatibility-minimum changes and no schema migrations.
- better-auth remains on 1.6.20. The open advisories against it (magic link,
  OAuth Proxy, DB-backed rate limiting) do not apply to this configuration;
  the device-flow one is mitigated by the typed-code change above. The 1.7
  upgrade is planned separately.

## 0.9.1

Server `server/v0.9.1` · Client unchanged (`v0.9.0`).

### Added
- **Deployment-configurable signup restriction.** Set `SIGNUP_EMAIL_DOMAIN` to
  require new accounts to have a provider-verified email at that exact domain
  (case-insensitive). The hosted service uses `tigerdata.com`; invitations do
  not bypass the restriction. Existing users of any domain can still sign in,
  link verified providers, and use their sessions, refresh tokens, and API keys.
  Self-hosted signup remains unrestricted when the setting is unset. Empty or
  malformed values fail startup. Blocked signups leave no user or linked account
  behind, and the sign-in page explains the restriction.

### Fixed
- CLI browser login preserves its authorization request after a failed social
  sign-in, allowing a user rejected with a personal GitHub email to retry with
  their TigerData Google account and finish logging in.

### Compatibility and database
- No CLI release, compatibility minimum changes, or schema migrations required.
  To reopen signup, unset `SIGNUP_EMAIL_DOMAIN` and restart all API replicas.

## 0.9.0

Server `server/v0.9.0` · Client `v0.9.0`.

An operations release: embedding workers can run as their own processes,
server telemetry is leaner and more useful for diagnosing memory pressure, and
search and batch-insert sizes have a tighter safety cap.

### Added
- **Standalone embedding workers.** New `./bun run worker` entry point
  (`packages/server/worker.ts`, also usable as a command override on the
  existing server image) runs embedding-queue consumers without an HTTP
  listener or migrations. Set `WORKER_COUNT=0` on the API server for API-only
  mode. Workers discover spaces through `DATABASE_URL`, can process queues
  through an optional `WORKER_DATABASE_URL`, and are tuned with the
  `WORKER_DB_*` pool/timeout settings. SIGTERM drains in-flight batches, and
  workers that were only partly started are cancelled cleanly on shutdown.
  Compose and Kubernetes defaults are unchanged.
- **`me import docs` reports `importedPaths`.** The `--json`/`--yaml` result
  now lists the source path of every doc that will be imported (relative to
  the import root, sorted, the same as `meta.repo_path`). Unreadable files and
  files left empty after frontmatter/MDX stripping are left out. With
  `--dry-run`, a caller can get the exact import set without reimplementing
  `--include`/`--exclude`.
- **Web UI copy buttons** on the frontmatter and metadata headings in the
  memory reading view.
- **Server observability for OOMs and per-principal operations:** process
  memory samples, per-process identity, search and JSON-response sizes,
  tokenizer-pressure diagnostics, and per-principal RPC operation attributes.
  See `design/runtime-observability.md`.

### Changed
- **Search results and `memory.batchCreate` are capped at 200** (was 1000).
  This applies to `--limit` / `limit` on search and to memories per batch
  insert. The CLI and MCP importers now split batch inserts into 200-item
  chunks. The web UI and CLI/MCP search lower their limits to 200; they make a
  single request and don't page. Hybrid `candidateLimit` still accepts up to
  1000. Direct API callers must keep search `limit` and batch sizes at or below
  200.
- **The server now requires client >= 0.9.0 (`MIN_CLIENT_VERSION`).** Older
  clients send `limit: 1000` (`me pack install`, `me pack list`, the default
  `me memory export`) and 1000-item batches, which the new caps reject. With
  this bump they get a clear upgrade error instead of "invalid params".
- `me memory export` and `me_memory_export` now return at most 200 memories.
  Paging is tracked in #228.
- **Telemetry defaults to a `lean` profile.** SDK metrics are off, and one
  runtime memory sample is logged at startup and every 60s.
  `LOGFIRE_TELEMETRY_PROFILE=diagnostic` turns on application HTTP metrics,
  snapshot gauges, and 10s samples. `LOGFIRE_RUNTIME_SAMPLE_INTERVAL_MS`
  overrides the sample interval (minimum 10000). `OTEL_METRIC_EXPORT_INTERVAL`
  no longer has any effect.
- Bun upgraded to 1.4.3. `@pydantic/logfire-node` 0.13 → 0.18, plus
  security and memory-related dependency upgrades (`ai`, `@ai-sdk/openai`,
  `next`). The Better Auth upgrade is deferred, so there is no auth schema
  change.

### Fixed
- `me` CLI: a refresh token the server rejects is now cleared instead of
  being sent again on every command, and a process never refreshes with a
  stale token after another process cleared the store. `me login` saves its
  tokens under the refresh lock, so a concurrent clear can't wipe a new login.
- Expected Better Auth 4xx responses no longer show up as errors in telemetry.
- `memory.history` by path and `memory.revert` no longer fail on
  TimescaleDB 2.30+. `has_tree_access` now uses a schema-qualified `ltree`
  operator.

### Database
- No schema version changes. The `has_tree_access` fix and the search limit
  change are in idempotent migrations, which are re-applied on every server
  boot.

## 0.8.0

Server `server/v0.8.0` · Client `v0.8.0`.

An audit-history release: every memory mutation is now recorded in an
append-only log, and any version can be restored.

### Added
- **Memory history.** Every insert, update, and delete is recorded as an
  immutable event carrying the actor, an app-level cause, the operation, a
  bulk-correlation id, and a full snapshot of the resulting (or, for deletes,
  removed) state. New `memory.history` RPC, `me memory history` / `me history`
  CLI, and the `me_memory_history` MCP tool answer who changed a memory, when,
  and how — including who deleted it. Scope by memory id, `tree/name` path,
  subtree, bulk operation id, or a `since` window (a space-wide activity feed),
  narrow by operation, page with a keyset cursor, and bound by `since`/`until`.
  Access is enforced per event by tree read access; deleted memories remain
  reachable by id or their old path.
- **Version revert and undelete.** New `memory.revert` RPC, `me memory revert` /
  `me revert` CLI, and the `me_memory_revert` MCP tool restore a memory to a
  prior version's snapshot, applied as a new forward version (it reproduces an
  earlier state rather than rewriting history). The full snapshot — content,
  metadata, tree, name, and temporal — is restored. Reverting a **deleted**
  memory re-creates it (undelete), continuing its version sequence. Revert is a
  deliberate override by default, with an optional `expectedVersionHash` guard
  against a concurrent change to a live memory.

### Changed
- The client now requires server >= 0.8.0 (`MIN_SERVER_VERSION`) because history
  and revert require server support added in this release. `MIN_CLIENT_VERSION`
  stays at 0.4.0 — the existing `memory.*` data plane is unchanged, so older
  clients keep working.

### Database
- Space schema -> 0.0.9. Adds the append-only `memory_event` audit log: a trigger
  records every memory mutation with transaction-scoped actor attribution.
  Optionally a TimescaleDB hypertable partitioned by event time, with a 30-day
  retention policy — so history and revert reach back over that window — and it
  degrades to a plain table when the extension is absent.
- Core schema -> 0.0.7. `validate_api_key` now returns the API-key display name,
  so an API-key-authenticated mutation is attributed by key name in the log.
- Migrations auto-apply on server boot; rolling back to a pre-0.8.0 server image
  is refused by the downgrade guards on space and core.

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
