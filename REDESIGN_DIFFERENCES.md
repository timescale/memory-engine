# REDESIGN.md vs. Current Implementation — Differences

This document compares `REDESIGN.md` against the code as it actually exists on
the `multiplayer` branch. It is organized as:

1. TL;DR of the substantive divergences
2. Architectural divergences (design intent changed)
3. Naming / shape divergences (same idea, different surface)
4. Not yet implemented (gaps vs. the redesign)
5. Implemented beyond the redesign (exists in code, absent from the doc)
6. Confirmed matches (the redesign describes reality)
7. Doc-hygiene notes for REDESIGN.md itself

File references are `path:line` against the repo root.

---

## 1. TL;DR

### 1a. Differences

Where the doc and the code diverge but both build the feature. The **Decision**
column records items we've adjudicated (which side to keep); `—` = not yet
decided. Items the redesign lists but the code does **not** build live in §1b.

| # | Topic | Redesign says | Implementation does | Severity | Decision |
|---|-------|---------------|---------------------|----------|----------|
| A | Auth tables | `core.session`, `core.oauth_identity`, `core.oauth_flow` live in `core` | Separate `auth` schema (better-auth shaped): `auth.users/sessions/accounts/device_authorization/verifications`; `auth.users.id == core.principal.id` | **Major** | **Keep current** (see §2.A) |
| B | Tree provisioning / private areas | V1 provisions **no** structure; magic private paths **deferred**; creator gets `owner@root` | Reserved roots `home.<member_id>` (`~` sugar) + `share` (`SHARE_NAMESPACE`); creator gets `admin` + `owner@home` + `owner@share` (**not** `owner@root`); bare create defaults to `share` | **Major** | **Keep current** (UX; see §2.B) |
| D | Access function | `core.effective_tree_access(_space_id, _principal_id)` → `returns table(tree_path, access)` | `core.build_tree_access(_member_id, _space_id)` → `returns jsonb` | Naming | **Keep current** (see §3.D) |
| E | API endpoints | A single JSON-RPC API (implied) | **Two** endpoints: `/api/v1/memory/rpc` + `/api/v1/user/rpc`, plus REST `/api/v1/auth/*` | Naming/shape | — |

### 1b. Not implemented (gaps vs. the redesign)

Listed in the redesign but not built. Detail in §4.

| # | Topic | Redesign wants | Status |
|---|-------|----------------|--------|
| C | Embedding config | Per-space model/dimension, recorded in `core.space` | Not implemented (hardcoded uniform; templated DDL only) |
| F | Last-admin safeguard | Must prevent removing/demoting the last admin | Not implemented |
| G | `me memory copy`/`cp` | Listed in §"Memory Commands" | Not implemented |
| H | `me user group list` | The one supported `me user` command for v1 | Not implemented |

The agent access-masking model (the part the doc was least confident about) **is**
implemented as designed — see §6.

---

## 2. Architectural divergences

### A. Auth lives in a separate `auth` schema, not in `core` — decision: **keep the current implementation**

The redesign places all authentication state in `core`: `core.session`,
`core.oauth_identity`, `core.oauth_flow`. The implementation instead uses a
dedicated **`auth` schema** shaped like better-auth, and `core` contains no auth
tables at all.

Actual `auth` schema (`packages/database/auth/migrate/incremental/`):

- `auth.users` (`001_users.sql:5`) — `id, name, email, email_verified, image, created_at, updated_at`. **`auth.users.id == core.principal.id`** for user principals.
- `auth.accounts` (`002_accounts.sql:8`) — OAuth provider links (`provider_id` ∈ {google, github}, tokens, scope). This is the redesign's `oauth_identity`.
- `auth.sessions` (`003_sessions.sql:10`) — `token_hash` (sha256), `expires_at`, `ip_address`, `user_agent`. This is the redesign's `session`.
- `auth.device_authorization` (`004_device_authorization.sql:7`) — device-code flow state. This is the redesign's `oauth_flow`.
- `auth.verifications` (`005_verifications.sql:7`) — present for better-auth shape parity.

Net effect: the "authorization boundary lives entirely in `core`" framing in the
redesign (§"Authorization Boundary") is true for *authorization* (principals,
grants, groups) but **not** for *authentication* — authentication is its own
schema. The redesign never mentions an `auth` schema or better-auth.

After evaluating the two, **keep the separate `auth` schema** and update
REDESIGN.md to describe it (per §7). Reasoning:

- **Separation of concerns is real.** Authn (sessions, OAuth secrets, device
  codes, PKCE, verification, expiry sweeps) and authz (the grant graph) have
  different security surfaces and change cadences. Intermingling token/secret
  tables with the grant graph — which every group/membership migration touches —
  is exactly what you want to avoid, and it's consistent with the design's own
  clean authz boundary (the `_tree_access` seam).
- **An established auth *shape* beats greenfield SQL auth.** The redesign's
  `core.oauth_flow`/`oauth_identity`/`session` are underspecified, hand-rolled
  auth. Mirroring better-auth's vetted model (account linking, multi-provider,
  verification, session lifecycle) is lower-risk and leaves a credible path to
  adopt the library or a managed service later.
- **The shared-id pattern neutralizes the redesign's main edge.**
  `auth.users.id == core.principal.id` is the standard "identity table ↔ domain
  entity share a PK" pattern: no mapping table, no meaningful duplication — two
  concern-specific rows under one id, written atomically by `provisionUser`
  (`packages/server/provision.ts:80,89`). You keep ~all the simplicity of "one
  identity" while keeping the boundary.
- **Preserves optionality.** The deliberate absence of a cross-schema FK keeps
  `auth` splittable onto its own DB/service later (`packages/database/index.ts`
  notes it could be "distributed across databases again").

Caveats (cost of this choice):

- It follows better-auth's **shape**, not the library — `packages/auth` depends
  only on `@memory.build/database` + `postgres`, with deliberate divergences
  (sha256 `token_hash`; a bespoke `device_authorization`). So the win is a vetted
  schema + upgrade path, not free battle-tested code.
- `auth.verifications` is a **dead table** carried for shape parity (never
  written).
- The `auth.users` ⇄ `core.principal` invariant is **app-enforced only** (no DB
  FK). Whether to add one is its own decision — see
  `DECISIONS_FOR_REVIEW.md` → "No cross-schema FK between `core.principal` and
  `auth.users`" (current call: don't, defer to user-deletion / standalone-users).

### B. Reserved tree paths and provisioning are built, not deferred — decision: **keep the current implementation**

This is the largest behavioral divergence. The redesign's V1 scope says (§"Private
Areas", §"me space create"):

- "We should **defer** magic private paths, implicit deny rules, and automatic
  private area behavior."
- "V1 does not provision any out-of-the-box tree organization. A newly created
  space starts with an empty tree."
- "The creating user receives… `owner` access on the **root** tree path."

The implementation instead bakes in two reserved roots and provisions them:

- `home.<member_id>` with `~` as input sugar — `HOME_NAMESPACE` and `homePrefix()`
  in `packages/database/space/path.ts:29,60`. `add_principal_to_space(...)`
  (`core/migrate/idempotent/006_membership.sql`) auto-grants a joining **user**
  `owner` on `home.<id>`.
- `share` — `SHARE_NAMESPACE` in `packages/database/space/path.ts:38`; a bare
  `memory.create` with no `tree` defaults here.
- A space **creator** gets `admin` + `owner@home.<user>` + `owner@share`, and
  **explicitly not `owner@root`** — `packages/server/provision.ts:55` (`addSpaceCreator`).
  This is the opposite of the redesign's "creator gets owner@root."

Functionally these are still ordinary positive ltree grants (no deny rules, no
implicit subtraction), so the redesign's *non-goal* of "no negative access" is
respected. But the **convention layer the redesign deferred is shipped**, and the
creator's grant is `home`+`share` rather than `root`. Any reader of REDESIGN.md
would expect a fresh space to be empty and root-owned; it is neither.

**Decision: keep current — implemented deliberately, for UX.** Multiplayer spaces
need a usable shared/private layout out of the box; making every new space's admin
design an access model from scratch before writing a single memory is poor
onboarding. The redesign itself calls the motivation valid and lists the
shared/private provisioning as a `me space create` **stretch goal** — we chose to
ship it. Importantly it's built the way the redesign *preferred*: ordinary
positive ltree grants over conventional `home`/`share` roots, **not** magic
private-path patterns or implicit deny rules — so the monotonic, no-deny non-goals
still hold (the access evaluator stays a plain ltree-containment check). The one
substantive thing to fold into REDESIGN.md is that the creator gets
`owner@home` + `owner@share` rather than `owner@root` (so a creator doesn't see
other members' homes; as an admin it can self-grant `owner@root` if it wants the
whole tree).

---

## 3. Naming / shape divergences (same concept, different surface)

### D. Access resolution function — decision: **keep the current implementation**

- Redesign: `core.effective_tree_access(_space_id uuid, _principal_id uuid)
  returns table(tree_path ltree, access int4)`.
- Actual: `core.build_tree_access(_member_id uuid, _space_id uuid) returns jsonb`
  (`core/migrate/idempotent/003_tree_access.sql:131`). Differences: **name**,
  **argument order**, takes **`_member_id`** (not `principal_id`), and returns a
  **JSONB array** of `{tree_path, access}` objects rather than a SQL table.

After evaluating the two, the current implementation is **better or equal on
every axis** — so we keep the code and (per §7) treat REDESIGN.md's signature as
the weaker spec to be updated. Reasoning per axis:

- **Parameter `_member_id` (current) > `_principal_id` (redesign) — correctness.**
  Effective access is only ever computed for an *authenticating actor* (a user or
  agent). A group never authenticates and isn't owner-maskable, and
  `build_tree_access` only dispatches `'u'`/`'a'`. `member_id` (the u|a-only
  generated column) encodes that constraint in the signature; the redesign's
  `_principal_id` is looser and wrongly implies a group could be passed.
- **Argument order `(member_id, space_id)` (current) — consistency.** The whole
  helper family is subject-first: `user_tree_access(_user_id, _space_id)`,
  `agent_tree_access(_agent_id, _space_id)`, `member_tree_access(…, _space_id)`
  (`003_tree_access.sql`). The redesign's space-first order would make the public
  entry the lone exception.
- **Return type `jsonb` (current) vs `table` (redesign) — `jsonb` fits this
  architecture; the table form's edge is unrealized.** The set always
  round-trips through the application layer: `build_tree_access` → TS array
  (`packages/engine/core/db.ts:429`), where the app uses it for the **auth gate**
  (`treeAccess.length === 0` → 403, `authenticate-space.ts`) and **owner checks**
  (`rpc/memory/support.ts`), then passes it **back into every space function as a
  jsonb argument** (`sql.json(treeAccess)::jsonb`,
  `packages/engine/space/db.ts:101`; consumed via `jsonb_to_recordset` in
  `space/migrate/idempotent/001_memory.sql:33`). The only advantage of a
  table-returning function — joining it directly in SQL — is never used, because
  nothing computes access purely in-SQL; the app is always in the loop. And it
  would save nothing: postgres.js parses either return shape into the same
  `[{tree_path, access}]` JS array, and the app re-serializes with `sql.json(…)`
  on the way back down regardless. Meanwhile `jsonb` matches the future sharded
  pushdown with **zero refactor**, and the typed/composable layer the redesign
  wanted **already exists internally** as the `*_tree_access` table functions —
  `build_tree_access` is explicitly just the jsonb *bridge* on top of them.
- **Name `build_` vs `effective_` — cosmetic, the only place the redesign reads
  nicer.** "Effective access" is the precise term for net/resolved permissions;
  "build" describes the bridge role (its doc comment: "the bridge … returns …
  the jsonb array shape"). Not worth a rename across SQL + `CLAUDE.md` + TS. If a
  more semantic public name is ever wanted, `effective_tree_access` (returning
  jsonb) is the one thing worth lifting from the redesign.

Per CLAUDE.md the auth gate is "non-empty `build_tree_access`."

### E. Two RPC endpoints, plus REST auth

The redesign describes "the hosted API server exposes JSON-RPC over HTTPS" as a
single surface. The implementation splits it (`packages/server/router.ts:252`):

- `/api/v1/memory/rpc` — session **or** api-key + required `X-Me-Space`. Hosts
  `memory.*`, `principal.*`, `group.*`, `grant.*`, `invite.*`.
- `/api/v1/user/rpc` — **session only** (api keys rejected here). Hosts `whoami`,
  `agent.*`, `apiKey.*`, `space.*`.
- `/api/v1/auth/*` — REST device-flow endpoints (`device/code`, `device/token`,
  `device/verify`, `device/approve`, `callback/:provider`).

The split (agents can't manage agents/spaces) is a real design decision absent
from the doc.

### CLI verb renames (vs. the redesign's command list)

All same-intent, different spelling:

- `me space alter` → **`me space rename`** (`commands/space.ts:212`).
- `me agent group list` → **`me agent groups`** (`commands/agent.ts:161`).
- `me apikey revoke` → **`me apikey delete`/`rm`** (+ a `me apikey get`)
  (`commands/apikey.ts`). The rename aligns with the doc's own "no soft delete /
  hard delete" stance, but the doc text still says `revoke`.
- `me group member add/remove/list` → **`me group add` / `remove`(`rm-member`) /
  `members`** (`commands/group.ts`).

---

## 4. Not yet implemented (gaps vs. the redesign)

- **C. Per-space embedding config + placement metadata.** The redesign (§"Space")
  wants the embedding model/dimension per-space, templated into the DDL, and
  recorded in `core.space`; the space record should also track placement (the
  shard). Built only partway: the DDL **is** templated
  (`embedding halfvec({{embedding_dimensions}})`,
  `space/migrate/incremental/001_memory.sql:10`), but the value is **hardcoded to
  1536 / `text-embedding-3-small` for every space** (`packages/server/config.ts:8`,
  `packages/server/index.ts:212`). `core.space` records neither model/dimension
  (it carries a TODO: `-- we likely need columns for embedding provider, model,
  dimensions`, `core/migrate/incremental/001_space.sql:9`) nor a shard/placement
  column. Consistent with the "no sharding in v1" non-goal, but the per-space
  hooks the redesign called for aren't there yet.
- **F. Last-admin safeguard.** The redesign requires that no cascade or removal
  may strip the last `principal_space.admin = true` from a space (§"Last-Admin
  Safeguard", §`core.principal_space`). No such check exists in SQL or app code.
- **G. `me memory copy` / `cp`.** Listed in §"Memory Commands"; `move`/`mv`
  exists, `copy`/`cp` does not (`commands/memory.ts`). The MCP server likewise has
  `me_memory_mv` but no copy tool.
- **H. `me user group list <user>`.** The redesign names this the single
  supported `me user` command for v1; there is **no `me user` command** at all.
- **Verified-email enforcement on invite acceptance.** The redesign (§`core.space_invitation`)
  wants acceptance to require an OAuth-verified email matching the invitation
  ("possession of an invite link alone should not be sufficient"). Invitations
  are implemented (`invite create/list/revoke`, `redeem_space_invitations`), but
  the verified-email match requirement should be confirmed against
  `009_invitation.sql` / redemption before relying on it.

---

## 5. Implemented beyond the redesign (in code, not in the doc)

- **`me agent add <agent>`** — adds one of your global agents to the active space
  (`commands/agent.ts:134`). The redesign treats agent→space admission as implied
  by `principal_space` but never gives it a command. (Agents are global; they must
  be admitted to a space before they can hold a key/grants there.)
- **Client/version gating.** `X-Client-Version` header check returns HTTP 426
  "Upgrade Required" below `MIN_CLIENT_VERSION` (`server/middleware/client-version.ts`),
  and the migrator rejects an app older than the DB version
  (`database/migrate/kit.ts:334`). The redesign mentions version *tables* for
  compatibility but not a client-version handshake.
- **`core.space.language`** column for the BM25 text-search config
  (`001_space.sql:8`) — per-space text language, not mentioned in the redesign.
- **Extra env vars:** `ME_SESSION_TOKEN` and `ME_NO_KEYCHAIN` (`packages/cli/credentials.ts`,
  `packages/cli/keychain.ts`) beyond the doc's `ME_SERVER`/`ME_API_KEY`/`ME_SPACE`.
- **CLI config split + keychain.** Implemented as `~/.config/me/config.yaml`
  (non-secret, per-server `active_space`) + `credentials.yaml` (0600 secret
  fallback) + OS keychain (macOS `security`, Linux `secret-tool`). The redesign
  only says "store session tokens somewhere… use keychain"; the concrete split is
  an elaboration.
- **Extra CLI surface:** `me serve` (web UI), `me pack`, `me claude` / `me codex`
  / `me gemini` / `me opencode` (install + import), `me completions`, `me version`,
  `me upgrade`. The doc only asks about a few of these.
- **MCP tool set is broader than the doc's list.** Actual tools
  (`packages/cli/mcp/server.ts`): `me_memory_create`, `me_memory_get`,
  `me_memory_search`, `me_memory_update`, `me_memory_delete`,
  `me_memory_delete_tree`, `me_memory_mv`, `me_memory_tree`, `me_memory_import`,
  `me_memory_export`. The redesign's local list omits `create`, `mv`, and
  `delete_tree`, and writes `update|patch` (there is a single `update`, no
  `patch`).
- **Transitive group admin (Model 2)** is implemented (`is_principal_space_admin`,
  `member_groups` in `003_tree_access.sql` / `001_principal_space.sql`): a user in
  an admin-flagged group inherits space admin; agents are excluded. The redesign
  discusses this but the concrete enforcement is in code.

---

## 6. Confirmed matches (the redesign describes reality)

These are worth recording because they are the parts the redesign was least sure
about or most opinionated on, and the code honors them:

- **Agent access runtime capping.** The "stronger interpretation" the redesign
  preferred — an agent's effective access is its configured access (direct +
  group-derived) **intersected with the owner's current effective access at
  runtime** — is implemented in `agent_tree_access` within
  `core/migrate/idempotent/003_tree_access.sql:54` (overlap → more-specific path,
  `least(access)`, then reduce redundant descendants). The doc's "vibe-coded
  sketch" became real SQL. The V1 rules hold: agents can't be space admins
  (`is_principal_space_admin` excludes `kind='a'`), can't be group admins
  (`member_groups` zeroes the admin flag for agents), may be group members, and
  inherited admin from an admin-flagged group does not make an agent an admin.
- **No soft deletes.** No `deleted_at`/`archived_at`/`is_deleted`/`active`
  anywhere; hard deletes via FK `on delete cascade` plus explicit cascade
  functions (`remove_principal_from_space`, etc.). Matches §"Deletion and
  Cascading".
- **Principal model.** `kind ∈ {u,a,g}`, generated `member_id` (u|a), generated
  `user_id`/`agent_id`/`group_id`, agent `owner_id → principal(user_id)`, name
  scoping (users global, agents per-owner, groups per-space). Matches §`core.principal`.
- **`tree_access` ladder** read=1 / write=2 / owner=3, applies to path + all
  descendants, monotonic, no deny table. Matches §`core.tree_access`. CLI verbs
  `grant` / `rm-grant` (no `revoke`) match the doc exactly (`commands/access.ts`).
- **Space schema tables** `<slug>.memory`, `<slug>.embedding_queue`,
  `<slug>.version`, `<slug>.migration`; `embedding_version` on memory; version-aware
  queue with `vt` / `outcome` / `attempts` / `last_error`; temporal `[a,a]` vs
  `[start,end)` convention enforced by check constraint. Matches §"Space" / §`<slug>.*`.
- **Transport & boundaries.** JSON-RPC over HTTP (not WebSockets), no hosted MCP
  server, local **stdio** MCP proxy that forwards through the client package using
  `ME_API_KEY`; `@memory.build/protocol` (Zod) is the contract source of truth and
  both `protocol` and `client` are published (`private: false`). Dependency flow
  protocol → server → client → CLI → MCP holds. Matches §"API, Client, and MCP
  Boundary".
- **`me memory` is optional / top-level.** Both `me memory <cmd>` and `me <cmd>`
  (e.g. `me search`, `me create`) work — answers the doc's open question "Can the
  memory commands be top-level?" with "yes."
- **Auth specifics** the doc implied: GitHub/Google OAuth, device-code flow,
  session + api-key secrets are **sha256** (not argon2), shared `extractBearerToken`
  helper. Matches.

---

## 7. Doc-hygiene notes for REDESIGN.md

If REDESIGN.md is meant to track reality, these lines are now stale:

- Move `core.session` / `core.oauth_identity` / `core.oauth_flow` out of the
  `core` section and document the separate `auth` schema (better-auth shape) —
  decided to keep the separate schema, see §2.A.
- §"Private Areas" / §"me space create": the `home`/`share`/`~` convention and the
  creator's `owner@home`+`owner@share` (not `owner@root`) grant are shipped, not
  deferred — decided to keep (implemented for UX, see §2.B); promote the
  shared/private provisioning from stretch goal to V1 scope.
- §"Space": `core.space` does not yet carry embedding or placement columns
  (there's a TODO); embedding is hardcoded uniform. Either implement or downgrade
  the prose to "future."
- §"Authorization Boundary": update `effective_tree_access(_space_id,
  _principal_id) returns table` to the real `build_tree_access(_member_id,
  _space_id) returns jsonb` — the current signature is the preferred one (see
  §3.D for the per-axis reasoning); optionally adopt the name `effective_…` while
  keeping the `_member_id` argument and jsonb return.
- Command list: `space alter`→`rename`, `apikey revoke`→`delete`, `agent group
  list`→`agent groups`; add `me agent add`; `me memory copy` and `me user group
  list` are unbuilt; the single-API framing should mention the two RPC endpoints
  + `/api/v1/auth/*`.
- Add the **last-admin safeguard** to a "not yet implemented" list so it isn't
  assumed to exist.
