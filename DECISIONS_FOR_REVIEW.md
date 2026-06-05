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
