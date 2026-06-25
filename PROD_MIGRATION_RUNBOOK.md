# Prod cutover runbook — old → multiplayer

Operational steps to cut production from the old org/engine/role model
(`server/v0.2.5`) to the new auth/core/space model, via a **maintenance window**:
stop the old app, run the ETL once into a new database, repoint + deploy the new
app, verify, re-issue agent keys. The **why** and the full mapping live in
`PROD_MIGRATION_PLAN.md`; the ETL is `packages/migrate-prod`. This doc is the
**how-to-operate**.

> ⚠️ **User-visible break: everyone re-authenticates after cutover.** Sessions do
> NOT migrate (better-auth stores raw session tokens; we only have old sha256
> hashes — plan §2.3), so **humans log in again** (a normal OAuth login, cheap).
> **Agents** additionally need a re-issued key — old keys are argon2-hashed +
> engine-scoped (`apiKey.create` → update `ME_API_KEY` where the agent runs). The
> agents are the old "service users"; run
> `survey.ts` for the current list (at the last §9 survey: 6 agents across 3
> owners). Plan the comms before starting.

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
  points at `DB_SHARD`).
- Prod is a k8s Deployment `memory-engine` in namespace `memory-engine`, deployed
  by pushing a `server/v*` tag (→ `timescale/tiger-agents-deploy`). The new app
  image must be built from a commit that includes PR #71 (the multiplayer model).

---

## 0. Rehearsal / smoke test (do this first, against a throwaway target)

The ETL never writes the sources, so you can rehearse it against the **real** prod
sources (read-only) writing to a **throwaway target** — no window, no risk.

1. Provision an empty test target (extensions creatable — see §1) and put its URL
   in `.env.local` as `DATABASE_URL` (alongside `DB_ACCOUNTS`/`DB_SHARD`; Bun
   auto-loads `.env.local`).
2. **Fast first pass — a few engines.** `MIGRATE_ENGINES` limits Phase B to a
   subset (Phase A still migrates all identities). Include the multi-member engine
   to exercise the role→group + member-roster path:
   ```
   MIGRATE_ENGINES=5ld4wito9c8o,<a-small-slug> bun packages/migrate-prod/run.ts
   ```
   Validates connectivity to all three DBs, target extensions/privileges, the
   control plane, and the complex path — in seconds.
3. **Full rehearsal.** Drop the `MIGRATE_ENGINES` var and run the whole thing:
   ```
   bun packages/migrate-prod/run.ts
   ```
   This copies all ~62k memories (batched inserts, ~500/statement) from prod
   (read-only), putting read load on the source shard. A measured remote-host
   rehearsal took **~15 min** — it's I/O-bound (≈1.8 GB of halfvec data over the
   WAN + HNSW index builds, ~3% CPU), so running **in-region** is materially
   faster. It validates timing and full correctness end-to-end.
4. **Verify** the target with the §5 queries (counts, ≥1 admin per space, access
   spot-check). Confirm the report has `skippedEngines: []` and `warnings: []`.
5. **To re-run**, reset the target first — the ETL is not idempotent on a dirty
   target (duplicate ids/slugs). Against the **test target only**:
   ```sql
   do $$ declare s text; begin
     for s in
       select nspname from pg_namespace
       where nspname in ('auth','core') or nspname ~ '^me_[a-z0-9]{12}$'
     loop execute format('drop schema if exists %I cascade', s); end loop;
   end $$;
   ```

---

## 1. Pre-flight (all must pass before you start)

- [ ] **Data verified (§9).** The DDL/data survey is done (plan §9.1). **Re-run
      `survey.ts` at cutover** for fresh numbers — expect roughly: ~32 users, 34
      active engines, ~62k memories, 0 orphans, every org with an owner.
- [ ] **Empty target database created** — just an empty database; the ETL
      connects but never `CREATE DATABASE`. **Do not pre-migrate it:** the ETL runs
      `migrateAuth`/`migrateCore` + per-engine `provisionSpace`, which create the
      `auth`/`core`/`me_<slug>` schemas and `create extension if not exists`
      (`citext`, `ltree`, `vector`/pgvector, `pg_textsearch` in `public`). So
      ensure those 4 extensions are installed **or** the ETL's role may create
      them (often superuser-only on managed Postgres), and that the role can
      create schemas (it then owns them).
- [ ] **Connections + privileges.** The ETL opens three connections:
      `DB_ACCOUNTS` (read `accounts.*`), `DB_SHARD` (read `me_<slug>.*`), and the
      target (create + own `auth`/`core`/`me_<slug>`). Confirm each role has the
      access it needs (see the Appendix privilege query).
- [ ] **ETL runnable against prod.** It's a separate workspace package
      (`@memory.build/migrate-prod`), not in the server image. Either run it from a
      maintenance host with the repo + bun and network access to all three
      databases, or as a one-off in-cluster Job whose image includes it, with
      `DB_ACCOUNTS`/`DB_SHARD`/`DATABASE_URL` from secrets.
- [ ] **Snapshots** of both source databases taken (the ETL doesn't modify them,
      but snapshot before any prod operation).
- [ ] **New app image built** from a post-PR#71 commit (a `server/v*` tag), ready
      to deploy but **not yet rolled out**; the chart DB-secret repoint (→ new DB)
      prepared.
- [ ] **Agent re-issue plan** ready: the list of agents (former service users,
      from `survey.ts`) and where each reads `ME_API_KEY`, plus the comms.

---

## 2. Rollback

The sources are read-only throughout, so rollback is trivial **until you
decommission them (§4)**:

1. Repoint the chart's DB secret back to `DB_SHARD`/`DB_ACCOUNTS` and redeploy the
   old `server/v0.2.5` image (or scale the new app to 0 and the old app back up).
   The old app sees its original, untouched databases.
2. Drop/abandon the new target database.

**Hard fallback:** restore a source snapshot (only needed if something external
mutated a source — the ETL never does). After §4, rollback = restore snapshots.

**Abort criteria during the run:** any ETL error that isn't a clearly-understood,
single-engine data anomaly; reconciliation counts that don't match (§5); the new
app failing its boot health check.

---

## 3. Cutover

1. **Announce** the window; freeze agent/CLI writes.
2. **Stop the old app** (halts writes to the sources):
   ```
   kubectl -n memory-engine scale deploy/memory-engine --replicas=0
   kubectl -n memory-engine rollout status deploy/memory-engine --timeout=120s
   ```
3. **Final snapshot** of the source databases (post-quiesce).
4. **Run the ETL** (three connections; target = the new DB):
   ```
   DB_ACCOUNTS="postgresql://…"  \
   DB_SHARD="postgresql://…"     \
   DATABASE_URL="postgresql://…" \   # the NEW target database
   bun packages/migrate-prod/run.ts
   ```
   The memory copy is batched (~62k rows, ~500/insert; the largest engine ~20.9k
   in one transaction). A remote rehearsal measured **~15 min** (I/O-bound, ≈1.8 GB
   over the WAN) — **run in-region to cut that down**. It prints a JSON report —
   check against the §9 survey: `engines` ≈ 34, `skippedEngines` = 0, `warnings` = 0
   (no dangling users / nested roles in prod). Investigate any surprise before
   proceeding.
5. **Verify** with the §5 reconciliation queries. **Gate:** counts match and every
   space has ≥1 admin. If not → abort + rollback (§2).
6. **Repoint + deploy the new app.** Update the chart DB secret to the new
   database, then push the new `server/v*` tag (→ tiger-agents-deploy). On boot it
   runs the idempotent `migrateCore`/`migrateAuth`/`remigrateSpaces` (no-ops over
   the ETL's work) and begins serving.
   ```
   kubectl -n memory-engine rollout status deploy/memory-engine --timeout=300s
   ```
   If boot crashloops on migration, the DB state is wrong — capture `kubectl logs`
   **before** Helm rolls back, then rollback (§2).
7. **Smoke test:** a known user logs in fresh (sessions don't migrate); lists
   spaces; reads a memory; runs a search (BM25 + semantic). The worker should
   drain `embedding_queue` for the few null-embedding memories.
8. **Re-issue agent API keys** and update each `ME_API_KEY`. Old keys are dead.
9. **Open the window.** Monitor logs/metrics + the embedding backfill for a soak.
10. **Decommission the old databases** — only after the soak (§4).

---

## 4. Decommission the old databases (after the soak)

There is no teardown SQL — the migration never modified the sources. Once cutover
is confirmed and the rollback window has closed, decommission `DB_ACCOUNTS` and
`DB_SHARD` per your infra (final snapshot, then drop/retire the instances). Keep
them intact until then so rollback (§2) stays a simple repoint.

Optional chart cleanup afterward: remove the now-unused `ACCOUNTS_DATABASE_URL`/
`ACCOUNTS_MASTER_KEY` and the pool-split values, leaving a single `DATABASE_URL`.

---

## 5. Appendix — verification queries

`verify.ts` runs all of the below automatically (read-only across the three DBs)
and prints a ✓/✗ checklist — `bun packages/migrate-prod/verify.ts`. It's
subset-aware (only checks spaces present in the target), so it works for a
rehearsal too. The raw queries follow for ad-hoc checks; run each `select`
against the connection named in its comment.

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

-- active engines (DB_ACCOUNTS) vs spaces (target) — equal (0 orphans in prod)
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
known owner (expect `owner@root`) and the one collaborator in the multi-member
space (expect only their granted subtrees + `home`).
