# Prod → Multiplayer migration plan

One-time ETL that moves production from the **old** org/engine/role + RLS model
(deployed at `server/v0.2.5`, SHA `a6cfabffdff437cb3aa7c8c5ca8d3550caac5acc`) to
the **new** auth/core/space model on `main` (PR #71, "feat: add core and space
migration packages").

> Status: **verified against live prod (read-only).** The §9 survey
> (`packages/migrate-prod/survey.ts`) confirmed the DDL and surveyed the data
> shape — results in §9.1. The mapping decisions below reflect what prod actually
> contains, not just assumptions.

This document is self-contained; the detailed source/target schema catalogs it
was built from lived in `/tmp/me-prod-v025-OLD-SCHEMA.md` and `/tmp/me-new-SCHEMA.md`
(ephemeral). The load-bearing facts are reproduced below.

> **Runbook**: `PROD_MIGRATION_RUNBOOK.md` — the step-by-step cutover (pre-flight,
> rollback, the maintenance-window cutover, decommission, verification SQL).
>
> **Implementation**: `packages/migrate-prod` — `migrateProdToMultiplayer(conns)`
> runs the whole ETL (Phases A+B) over three connections
> (`{accounts, shard, target}`); `migrateControlPlane`/`migrateEngine` are the
> per-phase functions. `run.ts` is the runner (env: `DB_ACCOUNTS`, `DB_SHARD`,
> `DATABASE_URL`=target). Sources are read-only, so there is no teardown SQL.
> Tested end-to-end in `migrate.integration.test.ts` (simple + complex scenarios)
> against a real Postgres; `mapping.test.ts` covers the grant-level mapping.

---

## 1. Topology: two source databases → one new database

Production runs **two separate databases**: `DB_ACCOUNTS` (identity — the
`accounts` schema) and `DB_SHARD` (memories — one `me_<slug>` schema per engine).
The ETL writes the new model to a **third, fresh database**, leaving both sources
untouched. Three connections: `accounts` (read), `shard` (read), `target` (write).

| | OLD (sources) | NEW (target) |
|---|---|---|
| physical database | **two** — `DB_ACCOUNTS` + `DB_SHARD` | **one new** — the app's `DATABASE_URL` |
| identity | `accounts` schema (in DB_ACCOUNTS) | `auth` schema |
| control plane | `accounts` (org/engine/member) | `core` schema |
| data plane | one `me_<slug>` schema per **engine** (in DB_SHARD) | one `me_<slug>` schema per **space** |
| access enforcement | Postgres **RLS** on `memory`, GUC `me.user_id`, roles `me_ro/me_rw/me_embed` | **no RLS, no roles**; `core.build_tree_access(member, space)` → jsonb passed to space SQL fns |
| cross links | soft UUID FKs across DBs: `DB_SHARD me_<slug>.user.identity_id` ↔ `DB_ACCOUNTS accounts.identity.id`; `accounts.engine.slug` ↔ `me_<slug>` | real FKs within `auth`/`core` |

### 1.1 Decision: fresh target database

Write the new model to a brand-new database; never modify the two sources.

- **No collisions** — sources and target are different databases, so each engine's
  slug is reused verbatim as its space slug (preserves `X-Me-Space` values and CLI
  active-space pointers) with nothing to vacate.
- **Rollback is trivial** — the sources are read-only throughout, so reverting is
  just pointing the app back at `DB_ACCOUNTS`/`DB_SHARD` (the old app). There is no
  in-place DDL, no rename, and no teardown SQL; decommissioning the old databases
  is a separate, out-of-band step after the cutover is confirmed.
- **Memory copy is cross-database** — since the shard and target are different
  databases, memories are copied by **streaming** (a cursor over `DB_SHARD`,
  batched inserts into the target), not `insert … select`. See §5.

Procedure:
1. Provision `auth` + `core` in the empty target DB; migrate identities/oauth/
   sessions from `DB_ACCOUNTS` (Phase A).
2. Per active engine (Phase B, one target transaction): `create_space` (reusing
   the slug) → `provisionSpace` a fresh `me_<slug>` in the target → build the
   roster + grants from `DB_ACCOUNTS` + `DB_SHARD` → stream-copy memories from
   `DB_SHARD`.
3. Point the app's `DATABASE_URL` at the target DB; verify; decommission the old
   databases later.

The ETL opens **three** connections: `accounts` (read `DB_ACCOUNTS`), `shard`
(read `DB_SHARD`), `target` (write the new DB).

---

## 2. Identity, auth, sessions

### 2.1 `accounts.identity` → `auth.users` + `core.principal`  (1 identity → 2 rows, shared id)

The new model's invariant is `auth.users.id == core.principal.id` for a user.
**Preserve `identity.id`** as that shared UUID (it's UUIDv7, passes the version
check on both tables).

| source `accounts.identity` | target |
|---|---|
| `id` | `auth.users.id` **and** `core.principal.id` (same value) |
| `email` (citext) | `auth.users.email`; **also** `core.principal.name` (the principal's globally-unique handle is the email) |
| `name` (display) | `auth.users.name` |
| `created_at` | both `created_at` |
| — | `auth.users.email_verified = true` (OAuth-only signups are verified), `core.principal.kind = 'u'` |

`core.principal.user_id/member_id` are **GENERATED ALWAYS** — never insert; they
derive from `id` + `kind`.

### 2.2 `accounts.oauth_account` → `auth.accounts`

Login link only. New `auth.accounts` does not use tokens (login-only); the old
AES-GCM-encrypted `access_token`/`refresh_token` are **dropped** (no functional
loss — the new server never reads them, so the `encryption_key` ring is not
needed at ETL time).

| source | target |
|---|---|
| `identity_id` | `user_id` (FK → auth.users) |
| `provider` | `provider_id` (`'google'`/`'github'`) |
| `provider_account_id` | `account_id` (the OAuth `sub`; unique with provider_id) |
| `created_at` | `created_at` |
| `access_token`/`refresh_token`/`encryption_key_id` | **dropped** |

### 2.3 `accounts.session` → `auth.sessions`  — *migrate (keep users logged in)*

**Both sides store `sha256(rawToken)` as `bytea` and look up by equality** — the
identical scheme. So sessions migrate verbatim and live CLI/browser logins keep
working across cutover.

| source | target |
|---|---|
| `token_hash` (bytea, sha256) | `token_hash` (bytea, sha256) — copy verbatim |
| `identity_id` | `user_id` |
| `expires_at`, `created_at` | same |
| — | `ip_address`/`user_agent` null (old didn't track) |

> **Parity (confirmed from code)**: old and new both compute
> `new Bun.CryptoHasher("sha256").update(token).digest()` → bytea and look up by
> equality (old `packages/accounts/util/hash.ts`; new `packages/auth/token.ts` +
> `auth.validate_session`). So copying `token_hash` verbatim keeps sessions valid.
> §9 leaves only a belt-and-suspenders check that `validate_session` adds no other
> gate; if it ever diverges, drop sessions and force re-login (low impact).

### 2.4 Not migrated (auth side)

- `device_authorization` — ephemeral (~15 min TTL); will be expired at cutover. Seed nothing.
- `verifications` — kept empty for better-auth parity (new model seeds nothing).
- `encryption_key` — old-only (OAuth-token envelope encryption); new model doesn't store those tokens.

---

## 3. Org / engine → space + roster

This is the structural heart of the migration.

- Each **active** `accounts.engine` (`status='active'`) → one `core.space`.
  - `space.slug` = `engine.slug` (reuse the 12-char slug — valid `^[a-z0-9]{12}$`
    for the new model too, and becomes the new `me_<slug>` schema name).
  - `space.name` = `engine.name`; `space.language` = `engine.language`.
- The owning `org`'s members (`org_member`) become the **space roster**
  (`core.principal_space`). The `org` row itself has no new-model equivalent and
  is **dropped** (it was a billing/name + roster container; the roster moves to
  the space, the billing/name is gone). `shard` is dropped.

### 3.1 Roster expansion  — *default: full org-member expansion; confirm against real data*

For each active engine E owned by org O, for **each** `org_member (identity, role)` of O:

| old `org_member.role` | new `principal_space.admin` | new grants in the space |
|---|---|---|
| `owner` | `true` | **owner@root** (`tree_access` tree_path `''`, access 3) — they were engine superusers |
| `admin` | `true` | **owner@root** (also superusers) |
| `member` | `false` | replicate the member's materialized engine grants (§4); no root access |

Plus: every rostered member also receives **owner@home** automatically (user →
`home.<userId>`, access 3), because we join via `core.add_principal_to_space`
(the new "join chokepoint"), which mirrors native app behavior. The old model had
no home/share convention, so this is *new* access — but only to the member's own
(initially empty) private namespace, so it's harmless and keeps migrated spaces
behaving exactly like natively-created ones.

> **Why full expansion**: in the old model an org member could `setupAccess` to
> *any* engine in the org (owner/admin → superuser, member → plain user). The
> faithful translation of "org membership grants engine access" is to roster
> every org member into every space derived from that org. The alternative —
> roster only identities that have a materialized `me_<slug>."user"` row — would
> drop members who had access rights but never happened to open that engine.
>
> **Confirm against prod (§9)**: if prod is dominated by single-member "Personal"
> orgs (the first-login auto-provisioning pattern: org "Personal" + engine
> "default", one owner), expansion is a no-op and this whole subsection collapses
> to "owner → admin + owner@root". Multi-member orgs are the only case where the
> expansion choice is observable.

### 3.2 `enforce_last_admin` (new) constraint

Every live space must end the load transaction with ≥1 **effective user-admin**
(a direct admin user, or a direct member of an admin group). Org owners/admins map
to `admin=true`, so any org with ≥1 owner/admin user satisfies it. The old
"≥1 org owner" invariant is *app-enforced only* at this tag (the DB trigger was
dropped in migration 008), so data may technically violate it — **the ETL must
assert each space gets ≥1 admin and fail loudly (or promote a deterministic
fallback) if an org has none.**

---

## 4. Engine-internal access → `core` access

Old per-engine access lived in `me_<slug>.{user, tree_owner, tree_grant, role_membership}`.

### 4.1 `me_<slug>."user"` rows

| old user row | maps to |
|---|---|
| `can_login=true`, `identity_id` set | the identity's **existing principal** (created in §2.1). Its grants attach to that principal in this space. |
| `can_login=false` (an RBAC **role**) | a new **group** principal (`kind='g'`, `space_id` = this space, `name` = the user's `name`). |
| `can_login=true`, `identity_id` NULL (service user — an agent with no identity) | a new **agent** (`kind='a'`) owned by the engine's **org owner**, joined to the space (owner@home.<owner>.<agent>); its `tree_owner`/`tree_grant` flow through like any principal, clamped under the owner's access. Confirmed in §9: every such user is the owner's own coding agent in a single-owner org. (The agent still needs a re-issued api key — §6.1.) |
| `can_login=true`, `identity_id` set but **not migrated** (dangling) | **no target** — grants dropped with a warning. (None in prod — §9.) |
| `superuser=true` | synthesize **owner@root** for the mapped principal (there is no `tree_owner` row recording superuser — it's a boolean). Org owner/admin already get owner@root via §3.1; this covers any other superuser. |

A single identity may have **multiple** `"user"` rows in one engine
(`idx_user_identity_id` is non-unique). **Merge** all their grants onto the one
principal, taking the **max** access level per `(principal, tree_path)`.

### 4.2 `tree_owner` → `tree_access` (owner)

`tree_owner(tree_path, user_id)` → `grant_tree_access(space, principal(user_id),
tree_path, access=3)`. Ownership = full access + delegation = new level 3.

### 4.3 `tree_grant` → `tree_access` (mapped level)  — *lossy, over-permissive; documented*

Old actions are a set drawn from `{read, create, update, delete}`. New access is a
single additive level `1 read ⊂ 2 write ⊂ 3 owner`.

| old `tree_grant.actions` / flags | new level |
|---|---|
| `{read}` only | 1 (read) |
| contains any of `create`/`update`/`delete` | 2 (write) |
| `with_grant_option = true` (may re-grant within subtree = delegation) | 3 (owner) |

This is **lossy in the permissive direction**: a `{delete}`-only or `{read,create}`
grant becomes full write (new write is additive: read+create+update+delete). The
4-action granularity has no lossless new representation. Expected to be acceptable
(and rare); flagged so it's a conscious choice.

Take the **max** level per `(principal, tree_path)` across all of a principal's
owner/grant sources.

### 4.4 `role_membership` → `core.group_member`

`role_membership(role_id, member_id, with_admin_option)` →
`group_member(space, group_id = group-of(role_id), member_id = principal-of(member_id),
admin = with_admin_option)`.

> **Nesting gap**: old roles can nest (a role that is a member of another role,
> cycle-checked). New `group_member.member_id` FKs the generated `member_id`
> column which is **u|a only** — so **new groups cannot nest**. Nested old roles
> must be **flattened** (attach each transitive u|a member directly to each group
> it inherits) or the ETL must error on detecting nesting. Expected absent in prod
> — confirm in §9. Membership-via-group is also only *effective* if the member
> also holds a direct `principal_space` row (handled by §3.1 expansion).

---

## 5. Memories → `me_<slug>.memory`

Near-identical row shape (both `halfvec(1536)` cosine HNSW + BM25 + ltree +
tstzrange + jsonb). Since the shard and target are **different databases**,
memories are copied by **streaming** — a cursor over `DB_SHARD me_<slug>.memory`
(batched) inserting into the freshly-provisioned target `me_<slug>.memory`. Each
row's `meta` is re-sent via `sql.json` (a text param in a jsonb slot
double-encodes — the postgres.js footgun in CLAUDE.md); `tree`/`temporal` are read
as text and re-cast (`::ltree`/`::tstzrange`); `embedding` is read as text and
re-cast `::halfvec` (dimensionless — the target column enforces 1536). Column
mapping:

| old `me_<slug>.memory` | new `me_<slug>.memory` |
|---|---|
| `id`, `meta`, `tree`, `temporal`, `content`, `embedding`, `embedding_version`, `created_at`, `updated_at` | same columns, **copy verbatim** |
| `created_by` (engine-user id) | **dropped** — the new `memory` table has no `created_by` column |
| `embedding_attempts`, `embedding_last_error` | dropped (bookkeeping; not in new schema) |

- **Tree paths preserved verbatim**, including root `''`. We do **not** remap into
  `share`/`home`; the existing hierarchy is kept losslessly. (Access to a given
  path is governed by the grants migrated in §3–4: owner@root principals see
  everything incl. root; members see only their granted subtrees + their own home.)
- **Bring embeddings.** Copy the `embedding` column so the insert path does **not**
  fire the `memory_enqueue_embedding_insert` trigger (which fires only when
  `embedding is null`). This avoids flooding `embedding_queue` and re-paying
  embedding-API cost. Rows whose old `embedding` is NULL will enqueue and the new
  worker backfills them — correct, since they need embedding anyway.
- The old `embedding_queue` is **not** migrated (transient worker state); the new
  one starts empty (+ whatever the NULL-embedding inserts enqueue).
- Only migrate memories from engines whose schema actually exists and whose
  `engine.status='active'`; reconcile the `accounts.engine` rows against the
  real `^me_[a-z0-9]{12}$` schemas present in the engine DB (status can lie after
  a mid-failure delete).

---

## 6. API keys & invitations

### 6.1 API keys — **NOT migrated (breaking; agents must re-issue)**

Old `me_<slug>.api_key.key_hash` is **argon2id** (one-way) and the key format is
engine-scoped `me.<slug>.<lookup>.<secret>`. New `core.api_key.secret` is
**sha256 hex**, global per-principal, format `me.<lookup>.<secret>`. The secret
can't be re-hashed (plaintext unknown) and the format/scope differ. We do **not**
create placeholder rows (a non-validating key is worse than none).

**Operational impact**: every agent must be re-issued an api key after cutover
(`apiKey.create`, then update `ME_API_KEY` wherever the agent runs). This is the
single biggest user-visible break — call it out in the cutover runbook.

### 6.2 Invitations — *optional; migrate pending only*

Old `accounts.invitation` is org-scoped and **token-based** (sha256 token_hash).
New `core.space_invitation` is space-scoped and **email-based** (redeemed by email
match on login via `redeem_space_invitations`, no token). Mapping for each
**pending** (`accepted_at IS NULL`, not expired) org invitation, per active engine
in the org:

| old | new `space_invitation` |
|---|---|
| (org) → each engine | one row per (space, email) |
| `email` | `email` |
| `role ∈ {owner,admin}` | `admin = true`; else `false` |
| — | `share_access = null` (old had no share) |
| `token_hash` | **dropped** (new redeems by email, not token) |

Accepted invites are already reflected as `org_member` rows (→ roster, §3).
Expired ones are dead. Low value / transient — migrate only if convenient.

---

## 7. Run procedure (two sources → new target)

The ETL opens three connections — `accounts` (read `DB_ACCOUNTS`), `shard` (read
`DB_SHARD`), `target` (write the new DB) — and reuses the new code's own
provisioning + `core` functions rather than re-implementing SQL.

**Phase A — control plane (target DB):**
1. **Provision** `auth` + `core` in the empty target DB (`migrateAuth` +
   `migrateCore`).
2. **Identities** (§2): for each `DB_ACCOUNTS accounts.identity` → insert
   `auth.users` (preserving the id) + `core.create_user(id, email)`; then
   `auth.accounts` (§2.2) and `auth.sessions` (§2.3, copied from `DB_ACCOUNTS`).

**Phase B — per active engine, one target transaction each:**
3. `core.create_space(slug, name, language)` (reusing the engine slug) →
   `provisionSpace(tx, {slug})` provisions a fresh `me_<slug>` in the target.
4. **Roster + grants** (§3–4), from `DB_ACCOUNTS` (org membership) + `DB_SHARD`
   (`user`/`tree_owner`/`tree_grant`/`role_membership`):
   `core.add_principal_to_space` (grants owner@home) → owner@root for org
   owner/admin and superusers → groups for `can_login=false` users + `group_member`
   + their grants → members' `tree_owner`/`tree_grant` via `grant_tree_access`
   (max level per path, §4).
5. **Memories** (§5): stream from `DB_SHARD me_<slug>.memory` → insert into the
   target `me_<slug>.memory` (carrying embeddings).
6. **Invitations** (§6.2): optional pending-invite rows for this space.

**Phase C — cutover & teardown:**
7. Point the app's `DATABASE_URL` at the target DB; verify (runbook §5).
8. **Decommission the old databases** out of band, after the cutover is confirmed.
   There is no teardown SQL — the sources were never modified.

Ordering within the target respects FKs: `auth.users`/`core.space` →
`core.principal` → `principal_space` → `group_member` → `tree_access` → `api_key`
(n/a) / `space_invitation` → `me_<slug>.memory`. `enforce_last_admin` is DEFERRABLE
INITIALLY DEFERRED, so build each space's roster fully within one transaction; the
check runs at commit.

> Each engine's transaction is independent and atomic — a failure rolls back that
> space's writes (the sources are untouched), so a half-built space simply isn't
> committed and the run can be retried.

---

## 8. Test plan (no prod access needed)

Build confidence entirely from synthetic data before touching prod. Implemented
in `packages/migrate-prod` (`old-schema.fixture.ts` + `migrate.integration.test.ts`):

1. **Stand up the OLD sources** from the in-repo fixture (a hand-mirrored
   server/v0.2.5 subset): an `accounts` schema and ≥2 `me_<slug>` engine schemas.
   The test stands in **one physical database** for all three connections —
   source per-engine schemas carry a distinct `shard_me_` prefix so they don't
   collide with the target `me_` schemas (prod has three real databases instead).
2. **Seed synthetic fixtures** covering: (a) the common case — a Personal org,
   single owner, one engine, memories at various tree paths incl. root, with and
   without embeddings; (b) the complex case — a multi-member org (owner + admin +
   member), explicit `tree_owner`/`tree_grant` (incl. read-only, write-ish, and
   with_grant_option), an RBAC role (`can_login=false` user + `role_membership`),
   orphans (engine user with dangling `identity_id`; deleted + active-without-schema
   engines).
3. **Run the ETL** with the three connections into the (same-physical, distinct-
   schema) target: provision `auth`/`core`, then per engine create+provision the
   space and stream-copy memories.
4. **Assert** against the new model: principal/space/roster/tree_access rows match
   the expected mapping; `enforce_last_admin` holds; memories copied with
   embeddings (queue holds only the null-embedding row); `build_tree_access(member,
   space)` reaches the group-derived grant; sources left untouched.
5. Lives in the suite as `*.integration.test.ts` against the local `me-postgres`
   container. The ETL itself never runs in CI against real data.

---

## 9. Verify against prod (do once read-only access exists)

The migration is drafted from code; these checks confirm reality matches and tell
us which complex paths are even exercised:

- [ ] Live `accounts` schema DDL matches the `server/v0.2.5` code (no manual drift
      / hotfix columns). Same for a sample of `me_<slug>` engine schemas.
- [ ] **Data-shape survey** (decides how much of §3.1/§4 matters):
  - how many orgs, and the distribution of `org_member` counts (are there *any*
    multi-member orgs, or is it all single-owner Personal orgs?);
  - how many engines per org; any `status != 'active'`;
  - any `me_<slug>."user"` with `can_login=false` (RBAC roles) or any
    `role_membership` rows (nesting?);
  - any non-trivial `tree_grant` (non-`{read,create,update,delete}`-full,
    `{delete}`-only, `with_grant_option=true`);
  - any `tree_owner` not at root;
  - orphans (cross-DB): `DB_SHARD me_<slug>.user` rows with an `identity_id` absent
    from `DB_ACCOUNTS accounts.identity`; `DB_SHARD me_<slug>` schemas with no
    `accounts.engine` row (and vice-versa); engines whose `status='active'` but the
    shard schema is missing.
- [ ] Session validation parity (§2.3) — confirm before relying on session migration.
- [ ] Counts to reconcile post-ETL: identities, oauth_accounts, sessions, engines→spaces,
      memories per engine.
- [ ] Confirm the cutover sequencing for api-key re-issue (§6.1) with whoever
      operates the agents.

### 9.1 Survey results (read-only, via `survey.ts`)

- **Topology**: `DB_ACCOUNTS` and `DB_SHARD` are **two distinct physical clusters**
  (different `system_identifier`s; both happen to be named `tsdb`). The cross-DB
  ETL is required. ✓
- **DDL**: every column the ETL reads is present in `accounts.*` and the sampled
  `me_<slug>` schema — **no drift** from the hand-mirrored server/v0.2.5 fixture. ✓
- **Scale**: 32 identities, 32 oauth accounts, 18 live sessions; 34 orgs,
  35 engines (**34 active**, 1 `deleted`), **62,111 memories**; only **4** lack
  embeddings; **0 pending invites**; all `english`.
- **Mostly trivial**: **33 of 34 orgs are single-owner / single-engine** → the
  simple owner→admin+owner@root path. Exactly **one** multi-member org (owner +
  1 member) with one RBAC role (1 membership edge, 2 grants, 1 tree_owner) — fully
  handled.
- **Service users**: **6** login-users-without-identity across 3 engines, **3
  holding 8 grants** — all confirmed to be each (sole org) owner's own coding
  agents (`claude`, `codex`, `sidekick`, …). → mapped to owner-owned agents (§4.1).
- **Grants**: 10 total, all "non-trivial"; the write-action ones widen to level-2
  write (the documented over-permissive lossiness, §4.3). 2 non-root tree_owners.
- **Anomalies**: **none** — every org has an owner; **0 orphans** (no
  engine↔schema mismatch, no dangling `identity_id`).
- **Sessions** (§2.3): hashing+lookup parity confirmed from code; 18 live sessions
  migrate verbatim.

---

## 10. Open decisions (defaults chosen; flag to override)

| # | decision | default | where it bites |
|---|---|---|---|
| 1 | target topology | **fresh target DB** — `DB_ACCOUNTS` + `DB_SHARD` → one new database; sources read-only | §1.1 |
| 2 | roster = all org members vs only realized engine users | **all org members** | §3.1 — only observable for multi-member orgs |
| 3 | migrate sessions vs force re-login | **migrate** (pending parity check) | §2.3 |
| 4 | api keys | **not migrated; re-issue** (forced by argon2) | §6.1 |
| 5 | memory tree paths | **preserve verbatim** (incl. root) | §5 |
| 6 | grant action→level mapping | **read→1, any write→2, grant-option→3** (lossy, over-permissive) | §4.3 |
| 7 | pending invitations | **migrate (optional)** | §6.2 |
| 8 | service users (`identity_id` NULL) | **map to an agent owned by the engine's org owner** (confirmed: each is the owner's coding agent) | §4.1 |
| 9 | nested roles | **error/flag** (absent in prod — only 1 flat role) | §4.4 |
