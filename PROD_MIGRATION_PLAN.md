# Prod → Multiplayer migration plan

One-time ETL that moves production from the **old** org/engine/role + RLS model
(deployed at `server/v0.2.5`, SHA `a6cfabffdff437cb3aa7c8c5ca8d3550caac5acc`) to
the **new** auth/core/space model on `main` (PR #71, "feat: add core and space
migration packages").

> Status: **drafted off code only.** Not yet verified against the live prod
> databases — see §9 "Verify against prod" for the checklist to run once
> read-only access is available. Treat every "expected to be rare/empty in prod"
> note as an assumption to confirm there.

This document is self-contained; the detailed source/target schema catalogs it
was built from lived in `/tmp/me-prod-v025-OLD-SCHEMA.md` and `/tmp/me-new-SCHEMA.md`
(ephemeral). The load-bearing facts are reproduced below.

> **Runbook**: `PROD_MIGRATION_RUNBOOK.md` — the step-by-step cutover (pre-flight,
> rollback, maintenance-window vs per-engine modes, teardown, verification SQL).
>
> **Implementation**: `packages/migrate-prod` — `migrateProdToMultiplayer(sql)`
> runs the whole ETL (Phases A+B); `migrateControlPlane`/`migrateEngine` are the
> per-phase functions for a zero-downtime cutover; `dropLegacy`/`dropAccounts`
> are the explicit Phase-C teardown. `run.ts` is the maintenance-window runner.
> Tested end-to-end in `migrate.integration.test.ts` (simple + complex scenarios)
> against a real Postgres; `mapping.test.ts` covers the grant-level mapping.

---

## 1. Topology: one database, schema swap in place

The old "two databases" (`accountsUrl` + `engineUrl`) are **one physical
database**, two schema families. The new model installs **in-place** in that same
database, side-by-side with the old schemas; data schemas are cut over per engine
by renaming the old schema aside (see §1.1).

| | OLD (source) | NEW (target) |
|---|---|---|
| physical database | **one** (two connection URLs both resolve to it) | **same one** (single `DATABASE_URL`) |
| identity | `accounts` schema | `auth` schema |
| control plane | `accounts` (org/engine/member) | `core` schema |
| data plane | one `me_<slug>` schema per **engine** | one `me_<slug>` schema per **space** |
| access enforcement | Postgres **RLS** on `memory`, GUC `me.user_id`, roles `me_ro/me_rw/me_embed` | **no RLS, no roles** (verified); `core.build_tree_access(member, space)` → jsonb passed to space SQL fns |
| cross links | soft UUID FKs, now cross-**schema**: `me_<slug>.user.identity_id` ↔ `accounts.identity.id`; `accounts.engine.slug` ↔ `me_<slug>` | real FKs within `auth`/`core` |

### 1.1 Decision: in-place, reuse slugs, rename old aside

The new model installs **in the same database** as the old one. Collision analysis
(verified against code — `packages/database/space/migrate/migrate.ts:117`,
`space/migrate/provision.sql`, and a repo-wide check that the new model creates no
roles / RLS):

| object | old | new | coexist? |
|---|---|---|---|
| control-plane schema | `accounts` | `auth` + `core` | ✅ distinct names |
| extensions (`public`) | citext/ltree/vector/pg_textsearch | same | ✅ shared, idempotent |
| cluster roles | `me_ro`/`me_rw`/`me_embed` | **none** | ✅ old roles harmless |
| RLS / policies | on `me_<slug>.memory` | **none** | ✅ |
| data schema | `me_<slug>` (engine) | `me_<slug>` (space) | ⚠️ **only collision** — and only when the slug is reused |

We **reuse each engine's slug as its space slug** (preserves `X-Me-Space` values
and CLI active-space pointers). New `provisionSpace` skips `create schema` when the
schema already exists, then fails applying `001_memory` over the old `memory`
table — so a reused slug must be **vacated first**.

Procedure:
- Install `auth` + `core` **side-by-side** with the live `accounts` (zero
  collision); migrate identities while the old app still serves.
- Per engine, at its cutover (short window, that engine only):
  1. `alter schema me_<slug> rename to legacy_<slug>`
  2. `provisionSpace({slug})` recreates a fresh `me_<slug>` via the tested path
  3. `insert into me_<slug>.memory select … from legacy_<slug>.memory` — **same-DB**,
     fast, carries embeddings (no wire transfer of `halfvec(1536)` vectors)
  4. build the space's roster + grants (§3–4)
- After full cutover verification: `drop schema legacy_<slug> cascade` per engine,
  `drop schema accounts cascade`, drop the unused `me_ro/me_rw/me_embed` roles.

**Rollback** (per space, until `legacy_<slug>` is dropped): `drop schema me_<slug>
cascade; alter schema legacy_<slug> rename to me_<slug>` and repoint that space to
the old app. Old data is untouched under `legacy_<slug>` until the explicit final
drop. The control plane (`auth`/`core`) can be dropped wholesale to revert.

The ETL uses **one connection** to the single database (the old code's two URLs
both point at it). It still reads `accounts.*` and `legacy_<slug>.*` and writes
`auth`/`core`/`me_<slug>` — all in that one database.

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
| `can_login=true`, `identity_id` NULL (service user, no identity) | **no clean target** (no identity → no auth.users; agents need an owning user). **Flag & decide per-row**; expected rare/absent in prod. |
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
tstzrange + jsonb). After the fresh `me_<slug>` is provisioned and the old schema
renamed to `legacy_<slug>` (§1.1), copy rows with a **same-DB** statement:
`insert into me_<slug>.memory (…) select … from legacy_<slug>.memory` (no wire
transfer). Column mapping:

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

## 7. Run procedure (in-place, single DB)

All writes happen in the one database, beside the live old schemas. Reuse the new
code's own provisioning + `core` functions rather than re-implementing SQL
(idiomatic, already-tested).

**Phase A — control plane, can run while the old app is live:**
1. **Provision** `auth` + `core` (run `migrateAuth` + `migrateCore`) — installs
   beside the old `accounts` schema, zero collision (§1.1).
2. **Identities** (§2): for each `accounts.identity` → insert `auth.users` +
   `core.create_user(id, email)`; then `auth.accounts` (§2.2) and `auth.sessions`
   (§2.3).

**Phase B — per engine, in a short cutover window for that engine** (others stay live):
3. Stop old-app traffic to this engine, then **rename it aside**:
   `alter schema me_<slug> rename to legacy_<slug>`.
4. `core.create_space(slug, name, language)` (reusing the old slug) →
   `provisionSpace(tx, {slug})` recreates a fresh `me_<slug>`.
5. **Roster + grants** (§3–4): `core.add_principal_to_space(space, principal, admin)`
   (grants owner@home) → owner@root for org owner/admin and superusers
   (`grant_tree_access(space, p, '', 3)`) → groups for `can_login=false` users
   (`core.create_group`) + `group_member` + their grants → members'
   `tree_owner`/`tree_grant` via `grant_tree_access` (max level per path, §4).
6. **Memories** (§5): `insert into me_<slug>.memory select … from legacy_<slug>.memory`
   (same-DB, with embeddings).
7. **Invitations** (§6.2): optional pending-invite rows for this space.
8. Point the new app at this space; verify; move to the next engine.

**Phase C — teardown, after all engines are cut over and verified:**
9. `drop schema legacy_<slug> cascade` (each), `drop schema accounts cascade`,
   drop the unused `me_ro/me_rw/me_embed` roles.

Ordering within the target respects FKs: `auth.users`/`core.space` →
`core.principal` → `principal_space` → `group_member` → `tree_access` → `api_key`
(n/a) / `space_invitation` → `me_<slug>.memory`. `enforce_last_admin` is DEFERRABLE
INITIALLY DEFERRED, so build each space's roster fully within one transaction; the
check runs at commit.

> Phases A and B steps 4–7 are each idempotent-friendly to re-run on failure: a
> half-built space can be dropped (`drop schema me_<slug> cascade` + delete its
> `core.space`/roster rows) and rebuilt while `legacy_<slug>` still holds the
> untouched source. Don't drop `legacy_<slug>`/`accounts` until Phase C.

---

## 8. Test plan (no prod access needed)

Build confidence entirely from synthetic data before touching prod:

1. **Stand up an OLD source** in a scratch local Postgres: run the old migrations
   from the pinned worktree `/tmp/me-prod-v025` (`packages/accounts/migrate` +
   `packages/engine/migrate`) to create an `accounts` schema and ≥2 `me_<slug>`
   engine schemas.
2. **Seed synthetic fixtures** covering: (a) the common case — a Personal org,
   single owner, one engine, memories at various tree paths incl. root, with and
   without embeddings; (b) the complex case — a multi-member org (owner + admin +
   member), explicit `tree_owner`/`tree_grant` (incl. read-only, write-ish, and
   with_grant_option), an RBAC role (`can_login=false` user + `role_membership`),
   orphans (engine user with dangling `identity_id`; a `status!='active'` engine).
3. **Run the ETL in-place in the same scratch DB**: install `auth`/`core` beside
   `accounts`, then per engine rename `me_<slug>` → `legacy_<slug>`, provision
   fresh, same-DB copy. (This exercises the real production path, including the
   rename-aside and the coexistence of old + new schemas in one database.)
4. **Assert** against the new model: principal/space/roster/tree_access rows match
   the expected mapping; `enforce_last_admin` holds; memories copied with
   embeddings (queue stays empty for embedded rows); `build_tree_access(member,
   space)` reachability equals the old `tree_access(user, action)` reachability
   for sampled (member, path, action) tuples.
5. Wire it into the suite as `*.integration.test.ts` against the local
   `me-postgres` container (schema-isolated, `!process.env.TEST_CI` guards where
   needed — see CLAUDE.md). The ETL itself never runs in CI against real data.

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
  - orphans: engine users with dangling `identity_id`; `me_<slug>` schemas with no
    `accounts.engine` row (and vice-versa); engines whose `status='active'` but
    schema missing.
- [ ] Session validation parity (§2.3) — confirm before relying on session migration.
- [ ] Counts to reconcile post-ETL: identities, oauth_accounts, sessions, engines→spaces,
      memories per engine.
- [ ] Confirm the cutover sequencing for api-key re-issue (§6.1) with whoever
      operates the agents.

---

## 10. Open decisions (defaults chosen; flag to override)

| # | decision | default | where it bites |
|---|---|---|---|
| 1 | in-place vs fresh DB | **in-place, reuse slugs, rename old aside** (single DB; only `me_<slug>` collides) | §1.1 |
| 2 | roster = all org members vs only realized engine users | **all org members** | §3.1 — only observable for multi-member orgs |
| 3 | migrate sessions vs force re-login | **migrate** (pending parity check) | §2.3 |
| 4 | api keys | **not migrated; re-issue** (forced by argon2) | §6.1 |
| 5 | memory tree paths | **preserve verbatim** (incl. root) | §5 |
| 6 | grant action→level mapping | **read→1, any write→2, grant-option→3** (lossy, over-permissive) | §4.3 |
| 7 | pending invitations | **migrate (optional)** | §6.2 |
| 8 | service users (`identity_id` NULL) & nested roles | **error/flag** (expected absent in prod) | §4.1, §4.4 |
