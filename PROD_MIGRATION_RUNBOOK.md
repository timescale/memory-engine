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

The migration reads **two source databases** — `DB_ACCOUNTS` (identity) and
`DB_SHARD` (memories) — and writes a **third, new database**. The sources are
never modified.

Grounded facts this runbook relies on (verified in code):

- The new server **auto-migrates on boot** (`packages/server/start.ts`):
  `bootstrapSpaceDatabase` → `migrateCore` → `migrateAuth` → `remigrateSpaces`
  (re-runs `migrateSpace` for every `core.space`). All idempotent. ⇒ **run the
  ETL first**, so the new app's boot migration is a no-op and we avoid the
  `helm --wait --atomic` crashloop-then-rollback failure mode (CLAUDE.md footgun).
- The new server connects via `DATABASE_URL` (falling back to the legacy
  `ENGINE_DATABASE_URL`, `start.ts:202`). The target is a **new** database, so the
  chart's database secret **must be repointed** at it (the old `ENGINE_DATABASE_URL`
  points at `DB_SHARD`). This is a required chart change, unlike a same-DB cutover.
- Prod is a k8s Deployment `memory-engine` in namespace `memory-engine`, deployed
  by pushing a `server/v*` tag (→ `timescale/tiger-agents-deploy`). The new app
  image must be built from a commit that includes PR #71 (the multiplayer model).

---

## 0. Modes

- **Mode A — maintenance window (recommended).** Stop the old app, run the ETL
  once (all engines) into the new DB, repoint + deploy the new app, verify,
  re-issue keys. Simplest, lowest risk. Right default unless prod is large enough
  that a window is unacceptable.
- **Mode B — per-engine, zero-downtime.** Provision the control plane in the new
  DB while the old app serves, then cut over engines one at a time. More moving
  parts (the old app keeps reading the old DBs; the new app reads the new DB), so
  it needs per-engine traffic routing. Only worth it at scale.

Pick A unless the §9 survey shows a data volume / availability requirement that
forbids a short window.

---

## 1. Pre-flight (all must pass before you start)

- [ ] **§9 verification done** (PROD_MIGRATION_PLAN.md): live DDL matches
      `server/v0.2.5`; data survey complete (org sizes, RBAC roles, non-trivial
      grants, orphans). The survey tells you whether the complex paths are even
      exercised.
- [ ] **New target database provisioned** — an empty database with the required
      extensions available (`citext`, `ltree`, `vector`/pgvector, `pg_textsearch`
      in `public`). The ETL creates `auth`/`core`/`me_<slug>` in it.
- [ ] **Connections + privileges.** The ETL opens three connections:
      `DB_ACCOUNTS` (read `accounts.*`), `DB_SHARD` (read `me_<slug>.*`), and the
      target (create + own `auth`/`core`/`me_<slug>`). Confirm each role has the
      access it needs (the target role must own its schemas; see the Appendix
      privilege query).
- [ ] **ETL is runnable against prod.** It is a separate workspace package
      (`@memory.build/migrate-prod`), not in the server image. Choose one:
      (a) a one-off in-cluster Job/pod whose image includes `migrate-prod`, with
      `DB_ACCOUNTS`/`DB_SHARD`/`DATABASE_URL` from secrets; or (b) a maintenance
      host with the repo + bun and network access to all three databases. Stage
      this ahead of time.
- [ ] **Snapshots** of both source databases taken (belt-and-suspenders; the ETL
      doesn't modify them, but snapshot before any prod operation).
- [ ] **New app image built** from a post-PR#71 commit (a `server/v*` tag), ready
      to deploy, but **not yet rolled out**; the chart's DB secret update (→ new
      DB) prepared.
- [ ] **API-key re-issue plan**: list of agents + where each reads `ME_API_KEY`,
      and the comms to send.

---

## 2. Rollback plan (know this before you start)

Because the sources are read-only throughout, rollback is trivial **at any point
before you decommission them**:

1. Repoint the chart's DB secret back to `DB_SHARD` (and `DB_ACCOUNTS`) and
   redeploy the old `server/v0.2.5` image (or scale the new app to 0 and the old
   app back up). The old app sees its original, untouched databases.
2. The new target database can simply be dropped/abandoned.

**Hard fallback:** restore a source snapshot (only needed if something external
mutated a source — the ETL never does). Once the old databases are decommissioned
(§5), rollback = restore their snapshots.

Abort criteria during the run: any ETL error that isn't a clearly-understood,
single-engine data anomaly; reconciliation counts that don't match (Appendix); the
new app failing its boot health check.

---

## 3. Mode A — maintenance window

1. **Announce** the window; freeze writes from agents/CLIs.
2. **Stop the old app** (halts writes to the sources):
   ```
   kubectl -n memory-engine scale deploy/memory-engine --replicas=0
   kubectl -n memory-engine rollout status deploy/memory-engine --timeout=120s
   ```
3. **Snapshot** the source databases (final, post-quiesce).
4. **Run the ETL** (three connections; target = the new DB):
   ```
   DB_ACCOUNTS="postgresql://…"  \
   DB_SHARD="postgresql://…"     \
   DATABASE_URL="postgresql://…" \   # the NEW target database
   bun packages/migrate-prod/run.ts
   ```
   It prints a JSON report. Check: `identities`, `engines` (one per active
   engine), `skippedEngines` (expect only orphaned/inactive), and `warnings`
   (each is a dropped grant / dangling user / unsupported nesting — review every
   one; none should be surprising given the §9 survey).
5. **Verify** with the Appendix reconciliation queries. **Gate:** counts match and
   every space has ≥1 admin. If not → abort + rollback (§2).
6. **Repoint + deploy the new app.** Update the chart DB secret to the new
   database, then push the new `server/v*` tag (→ tiger-agents-deploy). On boot it
   runs the idempotent `migrateCore`/`migrateAuth`/`remigrateSpaces` (no-ops over
   the ETL's work) and begins serving.
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
10. **Decommission the old databases** — only after the soak (§5).

---

## 4. Mode B — per-engine, zero-downtime (alternative)

Provision the control plane in the new DB while the old app serves, then cut
engines over one at a time. Use the exported phase functions, not `run.ts`.

1. **Phase A while live:** `migrateControlPlane(conns, DEFAULT_CONFIG, {})` —
   provisions `auth`+`core` in the new DB and migrates identities/oauth/sessions
   from `DB_ACCOUNTS`. The old app is unaffected (different databases).
2. **Per engine** (repeat; each is one atomic target transaction):
   - Quiesce writes to that engine (app-level: the old app keeps serving others).
   - `migrateEngine(conns, cfg, engine, orgMembers, invitations, identityIds, opts)`
     — create + provision the space in the new DB, build roster/grants, stream-copy
     memories from `DB_SHARD`. On failure it rolls back (sources untouched).
   - Verify that space (Appendix, scoped to the slug); route that engine's traffic
     to the new app.
3. When all engines are cut over, make the new app the sole server (its boot
   `remigrateSpaces` is idempotent), then **decommission** the old DBs (§5).

> Mode B needs per-engine traffic routing between the old app (reading
> `DB_ACCOUNTS`/`DB_SHARD`) and the new app (reading the new DB) during the
> transition. If you don't have that routing, prefer Mode A.

---

## 5. Decommission the old databases (after the soak)

There is no teardown SQL — the migration never modified the sources. Once cutover
is confirmed and the rollback window has closed, decommission `DB_ACCOUNTS` and
`DB_SHARD` per your infra (final snapshot, then drop/retire the instances). Until
then, keep them intact so rollback (§2) stays a simple repoint.

Optionally follow up with the chart cleanup: remove the now-unused
`ACCOUNTS_DATABASE_URL`/`ACCOUNTS_MASTER_KEY` and the pool-split values, leaving a
single `DATABASE_URL`.

---

## 6. Appendix — verification queries

Run after the ETL (step 5). These span databases — run each `select` against the
connection named in its comment. Replace schema names if you ran under a prefix.

**Privilege pre-flight** (run as the **target** role, before starting):
```sql
select has_database_privilege(current_user, current_database(), 'create') as can_create_schema;
```
(And confirm the `DB_ACCOUNTS`/`DB_SHARD` roles can `select` the `accounts` /
`me_<slug>` schemas.)

**Reconciliation:**
```sql
-- identities (DB_ACCOUNTS) vs users + user principals (target) — all equal
select count(*) from accounts.identity;                  -- DB_ACCOUNTS
select count(*) from auth.users;                         -- target
select count(*) from core.principal where kind = 'u';    -- target

-- active engines (DB_ACCOUNTS) vs spaces (target) — equal minus skipped orphans
select count(*) from accounts.engine where status = 'active';  -- DB_ACCOUNTS
select count(*) from core.space;                               -- target

-- every space has >= 1 effective admin (target) — expect 0 rows
select s.slug, count(*) filter (where ps.admin) as admins
from core.space s
left join core.principal_space ps on ps.space_id = s.id
group by s.slug having count(*) filter (where ps.admin) = 0;

-- per engine: memory counts must match between DB_SHARD and the target
--   select count(*) from me_<slug>.memory;   -- DB_SHARD (source)
--   select count(*) from me_<slug>.memory;   -- target (new)
```

**Spot-check access parity** (sample a few members): the new
`core.build_tree_access(member_id, space_id)` reachable set (target) should cover
what the old `me_<slug>.tree_access(user_id, action)` allowed (DB_SHARD). Pick a
known owner/admin (expect `owner@root`) and a plain member (expect only their
granted subtrees + `home`).
