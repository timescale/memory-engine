# TNT-244 Release Runbook

TNT-244 removes agent principals, agent API keys, and impersonation from Memory
Engine. Release all committed phases together. Do not deploy an intermediate
commit.

## Before Release

1. Confirm normal production backups have completed.
2. Notify the four holders of retired agent API keys. Their keys will stop
   working after the migration; direct them to use a user PAT or service-account
   key as appropriate.
3. Record the current agent and agent-key inventory:

   ```sql
   -- (a) the agents themselves
   select p.id, p.name, p.owner_id
   from core.principal p
   where p.kind = 'a'
   order by p.name;

   -- (b) the api keys bound to those agents
   select k.id, k.name, k.member_id, k.restricted
   from core.api_key k
   join core.principal p on p.id = k.member_id
   where p.kind = 'a'
   order by k.name;

   -- (c) restricted-key declarations that will cascade with the key row
   select s.api_key_id, s.space_id, s.space_admin
   from core.api_key_space_access s
   join core.api_key k on k.id = s.api_key_id
   join core.principal p on p.id = k.member_id
   where p.kind = 'a';

   select t.api_key_id, t.space_id, t.tree_path::text, t.access
   from core.api_key_tree_access t
   join core.api_key k on k.id = t.api_key_id
   join core.principal p on p.id = k.member_id
   where p.kind = 'a';
   ```

4. Record the memory count at every retired agent-home path. These rows must
   remain in their existing paths after the migration. For each `me_<slug>`
   space schema and each `(owner_id, agent_id)` from step 3(a), run a variant
   of the following (agent-home paths follow `home.<hex_owner>.<hex_agent>`
   with hyphens stripped):

   ```sql
   -- Replace <slug>, <hex_owner>, <hex_agent> as needed.
   -- `<@` is ltree "descendant of", so this counts the home node itself
   -- plus everything beneath it.
   select tree::text, count(*) as memory_count
   from me_<slug>.memory
   where tree <@ 'home.<hex_owner>.<hex_agent>'::ltree
   group by tree
   order by tree;
   ```

   For a scripted sweep across every space, iterate over
   `select slug from core.space` and paste the resulting counts into the
   release ticket for step 3 of "After Release" to compare against.

5. Confirm expected user, group, and service-account access with a representative
   account in each production space.

6. **Effective-admin preflight — must return 0.** Application code has never
   granted an agent `principal_space.admin`, but the DB does not forbid it.
   Migration 018 deletes agent principals in one statement, which fires the
   deferred `enforce_last_admin` trigger; if any space's *only* remaining
   effective admin were an agent, the trigger would abort the migration with
   `LAST_ADMIN`. Verify pre-emptively:

   ```sql
   select count(*)
   from core.principal_space ps
   join core.principal p on p.id = ps.principal_id
   where ps.admin and p.kind = 'a';
   ```

   Any non-zero result means a space would otherwise be left without a user
   admin — resolve by promoting a user admin (`me group set-space-admin`, or
   a direct roster admin row) before the migration runs.

## Release

1. Merge the complete TNT-244 change set.
2. Run the server release as `0.7.0`. **At the `Bump MIN_CLIENT_VERSION?`
   prompt, enter `0.7.0`** — do not press Enter to keep the default. This is
   what makes older 0.6.x clients incompatible with the new server, matching
   step 4's expectation.
3. Run the client release as `0.7.0`. **At the `Bump MIN_SERVER_VERSION?`
   prompt, enter `0.7.0`** — again, do not press Enter to keep.
4. Treat the two releases as one maintenance-window deployment. Versioned
   `0.6.2` clients are intentionally incompatible with the new server;
   clients without a version header remain subject to the existing lenient
   behavior.

**Maintenance-window lock note.** Migration 018 issues
`ALTER TABLE core.principal ALTER COLUMN member_id SET EXPRESSION AS (...)`,
which takes an ACCESS EXCLUSIVE lock on `core.principal` and rewrites the
table (all row values recompute to the same values in practice, so it is
short — but it is a full-table event). This is why the two package releases
are done inside one maintenance window.

## After Release

1. Verify no agent principals remain:

   ```sql
   select count(*) from core.principal where kind = 'a';
   ```

2. Verify no API keys belong to retired agents (and no scoped declarations
   linger):

   ```sql
   select count(*)
   from core.api_key k
   join core.principal p on p.id = k.member_id
   where p.kind = 'a';

   -- Both should also be 0 (cascaded from api_key.id):
   select count(*) from core.api_key_space_access s
   where not exists (select 1 from core.api_key k where k.id = s.api_key_id);
   select count(*) from core.api_key_tree_access t
   where not exists (select 1 from core.api_key k where k.id = t.api_key_id);
   ```

3. Recheck the recorded agent-home memory counts and paths (step 4 above).
   Each `(tree, count)` pair must match the pre-release capture; no rows
   should have moved or been rewritten.

4. Verify no `core.tree_access` row references a deleted principal (a smoke
   check on the cascade — should always be 0):

   ```sql
   select count(*) from core.tree_access ta
   where not exists (select 1 from core.principal p where p.id = ta.principal_id);
   ```

5. Verify normal user-session, restricted-PAT, and service-account-key access
   with MCP and CLI operations.

6. Confirm legacy `X-Me-As-Agent` is ignored, and that old agent keys receive
   the normal invalid-key error.

7. Watch error logs and authentication failures during the maintenance window.

## Rollback

Do not attempt a schema-only rollback after migration 018 has run. Restore from
the normal production backup if rollback is required.
