# Decisions for review

Design/behavior decisions made during implementation that warrant a maintainer's
sign-off. Each entry records the decision, the alternative(s), why the call was
made, and how to change it. Once you've reviewed an entry, either fold it into
`CLAUDE.md` / `docs/` (ratified) or open a change (overridden), and delete it
here.

---

## `~` (home) resolves to the authenticated principal — an agent gets its *own* home

**Date:** 2026-06-05 · **Area:** tree-path normalization (`a94cfb0`)

A leading `~` in a tree path expands to `home.<principalId>` (UUID with hyphens
stripped) where the principal is **whoever the bearer token authenticates as**:
a human session → that user; an agent api key → that agent. So an agent's `~` is
`home.<agentId>` — the agent's own isolated home — **not** its owner's home.

**Alternative considered:** an agent's `~` maps to its owner's home
(`home.<ownerUserId>`), so an agent acting on a user's behalf writes into the
user's home tree.

**Why this call:** `~` consistently means "me" (the authenticated principal) —
simplest mental model, no owner lookup, and agent homes stay isolated. `~` is
opt-in sugar; an agent that wants a shared/space-wide location just uses an
explicit path (e.g. `projects/x`) instead of `~`.

**How to change it:** the home id is `ctx.principalId`, passed to the
normalizer/serializer in `packages/server/rpc/memory/support.ts`
(`inputTreePath` / `inputTreeFilter` / `displayTreePath`). To make an agent's `~`
resolve to its owner, resolve the owner id for agent principals there (the agent
principal has `ownerId`) and use it for both expansion and reverse-display. Note:
paths already stored under the current rule (`home.<agentId>.…`) would not
migrate automatically.

**Status:** needs review.

---

## Destructive space ops (`space.delete` / `space.rename`) gated on admin — no separate owner flag

**Date:** 2026-06-05 · **Area:** core authority model

`space.delete` and `space.rename` are gated on **space-admin**
(`principal_space.admin`, which is transitive through admin groups). `delete`
drops the whole `me_<slug>` schema — all of the space's memories — so **any**
space-admin, including one who inherited admin via a group, can destroy
everything.

**Decision:** leave it as-is for now. Admins can delete; we will **not** add a
distinct space-**owner** notion to protect destructive ops until someone
actually asks for it.

**Alternative (deferred):** a separate owner gate for the truly destructive ops
— e.g. a `principal_space.owner` flag, or treating owner@root as the gate —
keeping plain admin for routine structural management (groups, members, grants).
Would also need decisions on whether owner is transitive through groups
(probably not) and how ownership transfers.

**Revisit when:** there's a request for delete protection / "are you sure"
beyond the CLI's type-the-name confirmation, or the first report of an admin
nuking a space. At that point implement the owner gate above.

**Status:** decided (defer); revisit on request.

---

## Home grant at join is for users only — agents get no auto home

**Date:** 2026-06-05 · **Area:** membership (`add_principal_to_space`, INV-1)

`add_principal_to_space` now writes a real `owner @ home.<member>` grant when a
**user** joins a space (the single chokepoint every join path goes through:
provisioning, invite redemption, direct add). **Agents are deliberately excluded.**

**Why exclude agents:** `agent_tree_access` clamps an agent's effective grants to
its owner's — an agent can never exceed what its owner can reach. A typical owner
(an invited user) holds `owner@home.<ownerId>` and maybe `share`, but **nothing**
over `home.<agentId>`. So an auto `owner@home.<agentId>` grant would be clamped to
nothing: an inert, misleading row in `tree_access` that `build_tree_access` never
returns. Users have no clamp, so their home grant is always effective.

**Tension with the `~` decision above:** that entry frames an agent's `~` as
`home.<agentId>` — its own isolated home. With agents excluded here, an agent's
`~` still *resolves* to `home.<agentId>` but carries **no access by default**; the
agent can only use it if its owner explicitly grants it there (and, because of the
clamp, the owner must hold that access too).

**How to change it (give agents real homes):** options — (a) nest agent homes
under the owner (`home.<ownerId>.…`) so the owner's home grant covers them; or
(b) in `add_principal_to_space` for an agent, also grant the **owner**
`owner@home.<agentId>` so the clamp passes (owner can then see into agent homes);
or (c) relax the clamp for the agent's own home subtree. Each needs a deliberate
call on owner visibility into agent data. The gate is `and p.kind = 'u'` in
`packages/database/core/migrate/idempotent/006_membership.sql`.

**Status:** needs review.

---

## Should users be able to mint their own API keys? (currently agent-only)

**Date:** 2026-06-05 · **Area:** auth / api keys

API keys are currently **agent-only**: `apiKey.create` is gated by
`requireOwnedAgent`, and humans authenticate via session. But the intended CLI
surface treats `ME_API_KEY` as pointing to a "user | agent" and `me apikey
create` as defaulting to self — which implies users can mint their own keys.

**The decision:** allow user-owned api keys, or keep "humans use sessions only"?

**Cost if yes (small):** `validate_api_key` already returns the principal
regardless of kind and `authenticateSpace` works unchanged, so it's mostly
relaxing the `apiKey.create` gate to allow `member == self` (a user) in addition
to agents the caller owns.

**Why it's a real decision:** weigh CLI ergonomics (a user scripting against their
own space without a browser session) against the security stance that human auth
stays interactive/session-only — an api key is a long-lived bearer secret, so
making them mintable for users widens that surface.

**Status:** needs decision.

---

## No cross-schema FK between `core.principal` and `auth.users`

**Date:** 2026-06-06 · **Area:** auth / core schema boundary

For a user principal, `auth.users.id == core.principal.id`. That invariant is
**app-enforced only** — `provisionUser` writes both rows with the same id in one
`sql.begin` transaction (`packages/server/provision.ts:80,89`), and the two
schemas reference each other nowhere (`core.principal` has no FK to `auth.users`;
the `auth` migrations never mention `core`). **Decision: keep it app-enforced —
do not add a DB-level cross-schema FK now.**

**Alternative considered:** add `core.principal.user_id references auth.users(id)
on delete cascade`. This is clean in shape — `user_id` is the generated column
(`= id` when `kind='u'`, else null) and FKs ignore null columns, so it would
constrain *only* user principals and leave agents/groups untouched; the cascade
would also make "delete an identity" tear down the principal + its grant graph in
one statement.

**Why defer:**

- **It makes migration order load-bearing, and today it isn't.** `auth` and
  `core` are independent migrate runners; call sites order them inconsistently
  (`authenticate-space` migrates auth→core; the agent/api-key integration tests
  migrate core→auth). A core→auth FK forces auth-before-core everywhere and would
  require standardizing production orchestration + fixing those test setups.
- **It forecloses the deliberate split-DB hedge.** The no-FK decoupling is
  intentional — `packages/database/index.ts` notes `auth` could be "distributed
  across databases again" (it *was* a separate DB before the recent
  consolidation). A cross-schema FK only works within one database.
- **The drift it guards against is near-zero today.** The invariant has exactly
  one writer (`provisionUser`, atomic), there's no user-deletion flow yet, and in
  v1 every user principal is created via OAuth login (so always has an
  `auth.users` row).
- **It would prematurely settle a deferred design question** — "standalone
  non-OAuth users" (service accounts) are deferred; a hard FK bakes in "every user
  principal has an `auth.users` row," which should be decided when that lands.

**How to change it (add the FK):** add `core.principal.user_id references
auth.users(id) on delete cascade` (uses the existing u-only generated column),
standardize the migration order to **auth-first** (production + the integration
test `beforeAll`s), and decide whether standalone users get an `auth.users`
identity row. The natural moment is when adding a `user delete` flow or finalizing
standalone users — the cascade-on-identity-delete becomes a concrete win then. A
cheap interim guard: a test asserting every `core.principal` `kind='u'` has a
matching `auth.users` and vice versa.

**Status:** decided (defer); revisit with user-deletion / standalone users.
