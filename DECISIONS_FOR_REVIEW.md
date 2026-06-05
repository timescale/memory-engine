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
