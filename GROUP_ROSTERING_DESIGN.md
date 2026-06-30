# Design: roster group principals into `principal_space` (TNT-160)

**Ticket:** TNT-160 — `me access grant` does not support groups by name
**Status:** implemented
**Area:** core control plane — membership, groups, access grants

---

## Problem

`me access grant <group> <path> <level>` works when `<group>` is a principal
id, but fails by group **name** with "No group named '…' in this space."

## Root cause

- The CLI resolves a non-UUID argument via `principal.resolve`
  (`cli/util.ts` → `resolveSpacePrincipalId`).
- `principal.resolve` searches only the **space roster** — `list_space_principals`,
  which is `from core.principal_space join core.principal`
  (`server/rpc/memory/principal.ts`, `core/.../006_membership.sql`).
- `create_group` only inserts into `core.principal`; it has never written a
  `core.principal_space` row (true since the function was introduced). So a group
  is absent from the roster and name resolution returns zero matches.
- Granting by **id** works because `grant_tree_access` does a raw insert keyed on
  `(space_id, principal_id, tree_path)` with no roster/kind check
  (`007_grant.sql`). Hence by-id works, by-name fails.

## Three distinct ideas (previously conflated)

1. **A group's grants don't confer space membership.** A user added to a group
   gets that group's access only once they have *also* joined the space directly;
   until then the grant is dormant. Implemented and intended (the "no backdoor
   invite around `me space invite`" property): `member_tree_access` gates a
   group's grants on the *member's* own `principal_space` row.
2. **A group principal is itself absent from `principal_space`.** Incidental to how
   `create_group` was written, not a deliberate decision. This is the direct cause
   of the bug (name resolution reads the roster).
3. **`principal_space` as the single source of truth for who/what belongs to a
   space (including groups).** Under this model groups are rostered, with
   membership conferral still governed separately by (1).

Ideas (1) and (2) are independent: a group can hold a roster row without changing
whether a *user* in it is a space member — the conferral gate keys on the user
(`_member_id`), not the group. Today's behavior couples them by omission.

## Decision

Adopt idea (3): **roster group principals into `core.principal_space` on
creation.** This fixes TNT-160 (groups resolvable/grantable by name) and makes the
roster the single source of truth, while preserving:

- **No backdoor invite** — `member_tree_access` is unchanged; a group's grants
  still only take effect for members who hold their own `principal_space` row.
- **Groups are not nestable** — a primary design decision; enforced at the DB with
  a clear error, and groups are excluded from `<member>` resolution.

### Locked sub-decisions

- Group rows are rostered with **`admin = false`** by default. **Admin groups are
  now supported** (not deferred): the admin-group mechanism (`is_principal_space_admin`
  / `enforce_last_admin`) was always built to key on a group's own
  `principal_space.admin`, so the only thing missing was a way to set it.
  `create_group` takes an `_admin` flag, `set_group_admin` toggles it (guarded by
  `enforce_last_admin` on demotion), surfaced as `group.create --admin` /
  `me group set-admin`. (This withdraws the earlier "FM3 / block admin groups"
  idea, which would have removed a real, tested feature.)
- Group nesting is blocked at the DB (explicit guard) and groups are excluded from
  the `me group add/remove` member resolver.
- Member-only resolution is done **CLI-side** (Design A below). Promoting to a
  server-enforced form (Design B) later is additive and non-breaking.

## Why this is safe (key invariants)

- `group_member.member_id references principal(member_id)`, and `principal.member_id`
  is a generated column that is **null for groups** — so a group can *never* be
  inserted as a group member. Nesting is already structurally impossible; the
  explicit guard just replaces an opaque FK error with a clear one.
- `add_principal_to_space` is already group-aware: it guards that a group can only
  join its own space and skips the home grant (`kind in ('u','a')`).
- `enforce_last_admin` is inert for a non-admin group row: its `principal_space`
  triggers fire only `when old.admin`, and its effective-admin count is
  `kind='u'`-only.
- `build_tree_access` dispatches only on `kind in ('u','a')`; a group can never
  authenticate, so the auth gate is unaffected.
- `list_spaces_for_member` keys on `member_id` (null for groups), so a group row
  never appears as one of a member's spaces.

---

## Implementation plan

### SQL

- `packages/database/core/migrate/idempotent/005_principal.sql` → `create_group`:
  convert `language sql` → `plpgsql`; insert the `principal` row (as today), then
  call `add_principal_to_space(_space_id, new_id, false)`, return id. Signature
  unchanged (body/language only) → no `{{fn}}` guard needed. Reuses the existing
  group-aware chokepoint (skips the home grant; idempotent upsert).
- `packages/database/core/migrate/idempotent/006_membership.sql` → `add_group_member`:
  add an explicit guard raising a clear exception (errcode `23514` + hint) when
  `_member_id` is `kind='g'`. Body-only change. Covers the by-UUID path (FK already
  blocks it, but opaquely).

### CLI

- `packages/cli/util.ts`: add `resolveSpaceMemberId` — UUID pass-through; else
  `principal.resolve(name)` → filter `kind !== 'g'` → single/zero/multiple logic.
  A group-only match yields a precise error: "'X' is a group, not a member —
  groups can't be group members."
- `packages/cli/commands/group.ts` (the `add` and `remove` member resolution call
  sites): use `resolveSpaceMemberId`.
- `packages/cli/commands/access.ts` keeps `resolveSpacePrincipalId` (all kinds) →
  groups now resolve by name (the TNT-160 fix, free once rostering lands).

### Docs / comments (separate "on the roster" from "confers membership")

- `006_membership.sql` `list_space_principals` header — groups are now listed.
- `CLAUDE.md` / `AGENTS.md` "Membership is explicit, not transitive" bullet and the
  tree/principal sections — groups are rostered but still don't confer membership
  on their members.
- `docs/access-control.md`, `docs/cli/me-group.md`.
- `packages/engine/core/types.ts` (`SpacePrincipal` comment) and
  `packages/protocol/space/principal.ts` (resolve/list comments).

### Tests

- `packages/engine/core/core.integration.test.ts`: a created group now appears in
  `listSpacePrincipals` (and under `kind:'g'`); the existing "excludes group-only
  principals" test (about a *user* added only via a group) stays valid.
- `packages/engine/core/db.integration.test.ts`: the manual
  `addPrincipalToSpace(groupId)` becomes a redundant no-op; simplify or repoint to
  assert auto-rostering.
- New: `create_group` writes a `principal_space` row (`admin=false`, no home
  grant); `add_group_member` rejects a group member by id with the friendly error.
- `packages/server/rpc/memory/management.integration.test.ts`: re-validate roster
  counts; `principal.list` now includes groups.
- e2e (`e2e/cli.e2e.test.ts`): `me access grant <group-name>` succeeds;
  `me group add <group> <group-name>` is rejected.

### Verify (no change expected)

- `enforce_last_admin` stays inert for non-admin group rows.
- `me group delete` / `delete_principal`: FK cascade removes the new roster row;
  the `group_member` delete trigger early-outs for a non-admin group.
- `create_group` has no caller other than `group.create`.

## Out of scope (deferred)

- Decline-invite / opt-in membership flow.
- Design B: server-enforced member-only resolution
  (`principalResolveParams.kinds` / `memberOnly`).
- A CLI surface to remove a *user/agent* from a space (`principal.remove` has no
  CLI) — tracked separately as TNT-164.

---

## Impact: CLI commands

**Directly changed (does the new write):**
- `me group create <name>` — its server path gains the `principal_space` insert.

**Behavior change — group names become resolvable (today UUID-only):**
- `me access grant <principal> <path> <level>` — group `<principal>` resolvable by
  name (the TNT-160 fix).
- `me access rm-grant <principal> <path>` — same.
- `me access list [principal]` — group filter resolvable by name; the name column
  shows group names for group grants (via `principal.lookup`) instead of raw UUIDs.
- `me group add/remove <group> <member>` — `<member>` resolution now **excludes**
  groups (member-only resolver); attempting a group is rejected with a clear error.

**Indirect / verify-only (touch the roster but no intended UX change):**
- `me agent add`, `me space delete` (cascade), `me space list` / `invite*`,
  `me group list` / `mine` / `members`.

**Not a CLI surface:** `principal.list` now returns groups (admin-only RPC, used by
the client/SDK + tests); keep the `kind` filter so callers can narrow.
