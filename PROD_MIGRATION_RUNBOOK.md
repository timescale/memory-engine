# Prod cutover runbook — old → multiplayer

Operational steps to cut production from the old org/engine/role model
(`server/v0.2.5`) to the new auth/core/space model. The **why** and the full
mapping live in `PROD_MIGRATION_PLAN.md`; the ETL is `packages/migrate-prod`.
This doc is the **how-to-operate**.

> ⚠️ **One hard, user-visible break: API keys do not migrate.** Old keys are
> argon2-hashed and engine-scoped; every agent must be re-issued a key
> (`apiKey.create`) and have `ME_API_KEY` updated after cutover. Plan the comms
> and the re-issue list **before** starting. Sessions DO migrate (users stay
> logged in); see plan §2.3.

Grounded facts this runbook relies on (verified in code):

- The new server **auto-migrates on boot** (`packages/server/start.ts`):
  `bootstrapSpaceDatabase` → `migrateCore` → `migrateAuth` → `remigrateSpaces`
  (re-runs `migrateSpace` for every `core.space`). All idempotent. ⇒ **run the
  ETL first**, so the new app's boot migration is a no-op and we avoid the
  `helm --wait --atomic` crashloop-then-rollback failure mode (CLAUDE.md footgun).
- The new server connects via `DATABASE_URL`, with a **temporary** fallback to the
  legacy `ENGINE_DATABASE_URL` (`start.ts:202`). Because old `accounts` and
  `me_<slug>` are **one database**, the existing chart's `ENGINE_DATABASE_URL`
  already reaches everything — **no chart connection change is required** to cut
  over. (Switching the chart to a single `DATABASE_URL` can follow later.)
- Prod is a k8s Deployment `memory-engine` in namespace `memory-engine`, deployed
  by pushing a `server/v*` tag (→ `timescale/tiger-agents-deploy`). The new app
  image must be built from a commit that includes PR #71 (the multiplayer model).

---

## 0. Modes

- **Mode A — maintenance window (recommended).** Stop the old app, run the ETL
  once (all engines), deploy the new app, verify, re-issue keys. Simplest, lowest
  risk. Right default unless prod is large enough that a window is unacceptable.
- **Mode B — per-engine, zero-downtime.** Provision control plane while old serves,
  then cut over engines one at a time. More moving parts; only worth it at scale.

Pick A unless the §9 survey shows a data volume / availability requirement that
forbids a short window.

---

## 1. Pre-flight (all must pass before you start)

- [ ] **§9 verification done** (PROD_MIGRATION_PLAN.md): live DDL matches
      `server/v0.2.5`; data survey complete (org sizes, RBAC roles, non-trivial
      grants, orphans). The survey tells you whether the complex paths are even
      exercised.
- [ ] **ETL connection + privileges.** The ETL uses **one** connection and must:
      read `accounts.*`; create + own `auth`, `core`, and every new `me_<slug>`;
      `alter schema … rename`; read the old `me_<slug>.*`. Old `accounts` and
      `engine` may use **different DB roles** — confirm the role you run as can do
      all of the above (grant `usage`/`select` on `accounts`, or run as the DB
      owner/superuser). Verify with the privilege query in the Appendix.
- [ ] **ETL is runnable against prod.** It is a separate workspace package
      (`@memory.build/migrate-prod`), not in the server image. Choose one:
      (a) a one-off in-cluster Job/pod whose image includes `migrate-prod`, with
      `DATABASE_URL` from the existing `memory-engine-database` secret; or
      (b) a maintenance host with the repo + bun and network access to the DB.
      Decide and stage this ahead of time.
- [ ] **Backup / snapshot** of the database taken and its restore tested.
- [ ] **New app image built** from a post-PR#71 commit (a `server/v*` tag), ready
      to deploy, but **not yet rolled out**.
- [ ] **API-key re-issue plan**: list of agents + where each reads `ME_API_KEY`,
      and the comms to send.
- [ ] Confirm `ENGINE_DATABASE_URL` (chart) resolves to the **one** database that
      holds both `accounts` and the `me_<slug>` schemas.

---

## 2. Rollback plan (know this before you start)

- **Before teardown (Phase C), rollback is cheap.** Old data is untouched under
  `legacy_<slug>` and `accounts`. To revert:
  1. Scale the new app to 0 (or redeploy the old `server/v0.2.5` image).
  2. Per migrated engine: `drop schema if exists me_<slug> cascade;`
     `alter schema legacy_<slug> rename to me_<slug>;`
  3. `drop schema if exists auth cascade; drop schema if exists core cascade;`
  4. Scale the old app back up — it sees the original schemas, untouched.
- **Hard fallback:** restore the pre-cutover snapshot.
- **After Phase C** (legacy + accounts dropped): rollback = snapshot restore only.
  Do not run Phase C until you are confident.

Abort criteria during the run: any ETL error that isn't a clearly-understood,
single-engine data anomaly; reconciliation counts that don't match (Appendix);
the new app failing its boot health check.

---

## 3. Mode A — maintenance window

1. **Announce** the window; freeze writes from agents/CLIs.
2. **Stop the old app** (halts writes to the old schema):
   ```
   kubectl -n memory-engine scale deploy/memory-engine --replicas=0
   kubectl -n memory-engine rollout status deploy/memory-engine --timeout=120s
   ```
3. **Snapshot** the database (final, post-quiesce).
4. **Run the ETL** (as the privileged role; `DATABASE_URL` = the one DB):
   ```
   DATABASE_URL="postgresql://…" bun packages/migrate-prod/run.ts
   ```
   It prints a JSON report. Check: `identities`, `engines` (one per active
   engine), `skippedEngines` (expect only orphaned/inactive), and `warnings`
   (each is a dropped grant / dangling user / unsupported nesting — review every
   one; none should be surprising given the §9 survey).
5. **Verify** with the Appendix reconciliation queries. **Gate:** counts match and
   every space has ≥1 admin. If not → abort + rollback (§2).
6. **Deploy the new app.** Push the new `server/v*` tag (→ tiger-agents-deploy),
   or set the deployment image to the new tag. On boot it runs the idempotent
   `migrateCore`/`migrateAuth`/`remigrateSpaces` (no-ops over the ETL's work) and
   begins serving.
   ```
   kubectl -n memory-engine rollout status deploy/memory-engine --timeout=300s
   ```
   If boot crashloops on migration, the ETL/DB state is wrong — abort, capture
   `kubectl logs` **before** Helm rolls back, rollback (§2).
7. **Smoke test:** a known user logs in (session should still be valid — sessions
   migrated); lists spaces; reads a memory; runs a search (BM25 + semantic). The
   worker should drain `embedding_queue` for any null-embedding memories.
8. **Re-issue API keys** for every agent; update each `ME_API_KEY`. Old keys are
   dead.
9. **Open the window.** Monitor logs/metrics + the embedding backfill for a soak
   period.
10. **Phase C teardown** — only after the soak (§5).

---

## 4. Mode B — per-engine, zero-downtime (alternative)

Provision the control plane while the old app serves, then cut engines over one
at a time. Use the exported phase functions, not `run.ts`.

1. **Phase A while live:** `migrateControlPlane(sql, DEFAULT_SCHEMAS, {})` —
   provisions `auth`+`core` beside the live `accounts` and migrates
   identities/oauth/sessions. The old app is unaffected (it doesn't read
   auth/core).
2. **Per engine** (repeat; each is independent and atomic):
   - Quiesce writes to that engine (app-level: the old app keeps serving other
     engines).
   - `migrateEngine(sql, cfg, engine, orgMembers, invitations, identityIds, opts)`
     — one transaction: rename `me_<slug>` aside, provision fresh, roster/grants,
     copy memories. On failure it rolls back fully (old schema intact).
   - Verify that space (Appendix, scoped to the slug); point the new app at it.
3. When all engines are cut over, deploy the new app as the sole server (its boot
   `remigrateSpaces` is idempotent), then **Phase C**.

> Mode B needs a way to route per-engine traffic between old and new apps during
> the transition (both reading the same DB). If you don't have that routing,
> prefer Mode A.

---

## 5. Phase C — teardown (after the soak, irreversible-ish)

Only once cutover is confirmed and the rollback window has closed:

```
-- per migrated engine:
--   import { dropLegacy } from "@memory.build/migrate-prod"
--   await dropLegacy(sql, DEFAULT_SCHEMAS, slug)   -- drop schema legacy_<slug> cascade
-- then:
--   await dropAccounts(sql, DEFAULT_SCHEMAS)        -- drop schema accounts cascade
```

Then drop the now-unused old cluster roles: `drop role if exists me_ro, me_rw,
me_embed;` (only after no schema references them). Optionally follow up with the
chart change to swap `ENGINE_DATABASE_URL` → a single `DATABASE_URL` and remove
`ACCOUNTS_DATABASE_URL`/`ACCOUNTS_MASTER_KEY` and the pool-split values.

---

## 6. Appendix — verification queries

Run after the ETL (step 5), before deploying the app. Replace schema names if you
ran under a prefix.

**Privilege pre-flight** (run as the ETL role, before starting):
```sql
select has_schema_privilege(current_user, 'accounts', 'usage') as can_read_accounts,
       has_database_privilege(current_user, current_database(), 'create') as can_create_schema;
```

**Reconciliation:**
```sql
-- identities → users → user principals (must all be equal)
select (select count(*) from accounts.identity)            as old_identities,
       (select count(*) from auth.users)                   as new_users,
       (select count(*) from core.principal where kind='u') as user_principals;

-- active engines → spaces (equal, minus any orphaned/inactive skipped)
select (select count(*) from accounts.engine where status='active') as active_engines,
       (select count(*) from core.space)                            as spaces;

-- every space has >= 1 effective admin (else enforce_last_admin would have failed,
-- but confirm anyway)
select s.slug, count(*) filter (where ps.admin) as admins
from core.space s
left join core.principal_space ps on ps.space_id = s.id
group by s.slug having count(*) filter (where ps.admin) = 0;   -- expect 0 rows

-- per engine: memory counts must match legacy_<slug>
--   select count(*) from me_<slug>.memory;     -- new
--   select count(*) from legacy_<slug>.memory; -- old (until Phase C)
```

**Spot-check access parity** (sample a few members): the new
`core.build_tree_access(member_id, space_id)` reachable set should cover what the
old `me_<slug>.tree_access(user_id, action)` allowed. Pick a known
owner/admin (expect `owner@root`) and a plain member (expect only their granted
subtrees + `home`).
