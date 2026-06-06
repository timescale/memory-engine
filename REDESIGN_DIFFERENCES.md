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

## 1. TL;DR — the substantive divergences

| # | Topic | Redesign says | Implementation does | Severity |
|---|-------|---------------|---------------------|----------|
| A | Auth tables | `core.session`, `core.oauth_identity`, `core.oauth_flow` live in `core` | Separate `auth` schema (better-auth shaped): `auth.users/sessions/accounts/device_authorization/verifications`; `auth.users.id == core.principal.id` | **Major** |
| B | Tree provisioning / private areas | V1 provisions **no** structure; magic private paths **deferred**; creator gets `owner@root` | Reserved roots `home.<member_id>` (`~` sugar) + `share` (`SHARE_NAMESPACE`); creator gets `admin` + `owner@home` + `owner@share` (**not** `owner@root`); bare create defaults to `share` | **Major** |
| C | Embedding config | Per-space model/dimension, recorded in `core.space` | Hardcoded `text-embedding-3-small` / 1536 for all spaces; `core.space` has a TODO comment, no such columns | **Major** |
| D | Access function | `core.effective_tree_access(_space_id, _principal_id)` → `returns table(tree_path, access)` | `core.build_tree_access(_member_id, _space_id)` → `returns jsonb` | Naming |
| E | API endpoints | A single JSON-RPC API (implied) | **Two** endpoints: `/api/v1/memory/rpc` + `/api/v1/user/rpc`, plus REST `/api/v1/auth/*` | Naming/shape |
| F | Last-admin safeguard | Must prevent removing/demoting the last admin | **Not implemented** | Gap |
| G | `me memory copy`/`cp` | Listed | **Not implemented** | Gap |
| H | `me user group list` | The one supported user command for v1 | **Not implemented** | Gap |

The agent access-masking model (the part the doc was least confident about) **is**
implemented as designed — see §6.

---

## 2. Architectural divergences

### A. Auth lives in a separate `auth` schema, not in `core`

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

### B. Reserved tree paths and provisioning are built, not deferred

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

### C. Embedding model/dimension is hardcoded, not per-space

The redesign (§"Space") wants the embedding model and dimension to be per-space,
templated into the DDL, and recorded in `core.space` so the server can route
embedding work.

Reality is split:

- The DDL **is** templated: `embedding halfvec({{embedding_dimensions}})`
  (`space/migrate/incremental/001_memory.sql:10`). So the *mechanism* exists.
- But the value is **hardcoded to 1536 / `text-embedding-3-small` for every
  space** server-side (`packages/server/config.ts:8`, `packages/server/index.ts:212`
  comment: "Model and dimensions are hardcoded - all spaces use the same
  embedding model").
- `core.space` does **not** record provider/model/dimension. It literally carries
  a TODO: `-- we likely need columns for embedding provider, model, dimensions`
  (`core/migrate/incremental/001_space.sql:9`). There is also **no shard /
  placement column**, though the redesign (§`core.space`) says the space record
  "tracks placement information, such as the shard."

So the "per-space embedding" and "placement metadata in `core.space`" parts of the
redesign are not realized; all spaces are uniform and single-DB (consistent with
the "no sharding in v1" non-goal, but the metadata hooks the redesign called for
aren't there yet).

---

## 3. Naming / shape divergences (same concept, different surface)

### D. Access resolution function

- Redesign: `core.effective_tree_access(_space_id uuid, _principal_id uuid)
  returns table(tree_path ltree, access int4)`.
- Actual: `core.build_tree_access(_member_id uuid, _space_id uuid) returns jsonb`
  (`core/migrate/idempotent/003_tree_access.sql:131`). Differences: **name**,
  **argument order**, takes **`_member_id`** (not `principal_id`), and returns a
  **JSONB array** of `{tree_path, access}` objects rather than a SQL table.

Space functions consume it as a `_tree_access jsonb` argument
(`space/migrate/idempotent/001_memory.sql:33`), matching the redesign's
"pushed-down JSONB access set" future shape — but that's the *only* code path,
not a later optimization. Per CLAUDE.md the auth gate is "non-empty
`build_tree_access`."

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
  `core` section and document the separate `auth` schema (better-auth shape).
- §"Private Areas" / §"me space create": the `home`/`share`/`~` convention and the
  creator's `owner@home`+`owner@share` (not `owner@root`) grant are shipped, not
  deferred — update the V1 scope.
- §"Space": `core.space` does not yet carry embedding or placement columns
  (there's a TODO); embedding is hardcoded uniform. Either implement or downgrade
  the prose to "future."
- §"Authorization Boundary": rename `effective_tree_access(_space_id,
  _principal_id) returns table` to the real `build_tree_access(_member_id,
  _space_id) returns jsonb`.
- Command list: `space alter`→`rename`, `apikey revoke`→`delete`, `agent group
  list`→`agent groups`; add `me agent add`; `me memory copy` and `me user group
  list` are unbuilt; the single-API framing should mention the two RPC endpoints
  + `/api/v1/auth/*`.
- Add the **last-admin safeguard** to a "not yet implemented" list so it isn't
  assumed to exist.
