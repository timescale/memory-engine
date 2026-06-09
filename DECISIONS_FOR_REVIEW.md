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

## Rolling sessions (7d, refreshed daily, no absolute cap) — copied from better-auth

**Date:** 2026-06-08 · **Area:** auth / session lifetime

Sessions were a **fixed** 30-day expiry with no renewal — an actively-used login
died 30 days after `me login` regardless of activity. That became user-visible
once `me <tool> install` started defaulting to the login session (a logged-in
editor's MCP integration would silently break monthly). Changed to **rolling**
sessions matching better-auth's defaults: `validate_session` slides `expires_at`
to `now + 7d` on use, **throttled to ~once/day** (only when <6d remains, i.e.
window − updateAge), with **no absolute cap**. The function is now `volatile`
(was `stable`) and does at most ~one write/session/day on the hot path.

**Decision:** adopt better-auth's model verbatim (expiresIn=7d, updateAge=1d, no
cap). Initial window also dropped 30d → 7d (`SESSION_EXPIRY_DAYS`).

**The open tradeoff — no absolute cap:** OWASP recommends pairing an idle timeout
(which we now have: 7d) with an **absolute timeout** (a hard ceiling regardless of
activity) so a leaked-but-actively-used session can't roll forever. better-auth
omits this by default and we followed suit, prioritizing "never log out an active
user." A continuously-used (or exfiltrated-and-used) session never expires;
mitigations remain `me logout` / `deleteSessionsByUser` (revoke-all).

**How to add a cap later:** store `absolute_expires_at = created_at + <max>` (or
compute from the existing `sessions.created_at`) and `least(now()+7d,
absolute_expires_at)` in the `validate_session` bump; force re-login past it.
Window/throttle live in `packages/database/auth/migrate/idempotent/002_session.sql`
(`validate_session`) and `SESSION_EXPIRY_DAYS` in `packages/auth/db.ts` — keep the
two windows in sync.

**Status:** decided (copy better-auth); revisit the absolute cap if the
long-lived-bearer surface becomes a concern.

---

## Should an agent get `share` access on join by default, or no grants (as now)?

**Date:** 2026-06-08 · **Area:** membership (`me agent add` / `principal.add`)

Surfaced by the e2e suite: `me agent add` puts the agent on the roster but
grants it **nothing**, so a freshly-added agent (with a minted key) gets
`No access to this space` on its first `me search` — the auth gate is a
non-empty `build_tree_access`, and an agent joins with zero grants (see the
"Home grant at join is for users only" entry: agents get no auto home because
the `agent_tree_access` clamp would make it inert). To make the agent usable the
owner must run an explicit `me access grant <agent> share r` (or similar) after
adding it. The e2e api-key scenario does exactly that.

**The decision:** when an agent is added to a space, should it automatically
receive a default grant — most naturally **read on `share`**, the shared root —
so it's immediately usable, or should it keep getting **no grants** (today),
requiring the owner to grant access explicitly?

**Why it's a real decision:** weigh ergonomics (an added agent that can do
nothing until a second, easily-forgotten grant command is surprising) against
least-privilege (an agent should see only what its owner deliberately shares).
Note the clamp: an agent's effective access is bounded by its owner's, so a
default `read@share` would only take effect when the owner themselves can read
`share` (the space creator owns it; an invited member may or may not). A default
also raises "which level/path" (read vs write, `share` vs space-root) and whether
it should apply to all join paths (`principal.add`, invite redemption) or only
self-service `me agent add`.

**How to change it (add a default):** in `add_principal_to_space`
(`packages/database/core/migrate/idempotent/006_membership.sql`) add an
agent-branch that writes a `read @ share` grant (mirroring the user home-grant
branch gated on `p.kind = 'u'`), or do it at the RPC layer in `principal.add`
(`packages/server/rpc/memory/principal.ts`). Keeping it in the SQL chokepoint
makes it uniform across every join path.

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

---

## Claude Code plugin captures via the import path (Stop/SessionEnd transcript), not per-event

**Date:** 2026-06-09 · **Area:** claude-plugin / capture hook (`dd28e26`)

The plugin previously registered **`UserPromptSubmit`** (store your prompt) and
**`Stop`** (store the assistant's *final* message via `last_assistant_message`),
producing two memories per turn with a **bespoke metadata schema**. It now
registers **`Stop`** (after each turn) and **`SessionEnd`** (final flush), and
each fire reads `transcript_path` and runs the session through
`importTranscriptFile` — the *same* parse + write as `me … import`. So live
captures and bulk imports are **identical by construction**: same tree
(`share.projects.<project>.agent_sessions`), deterministic ids, and `source_*`
metadata, one memory per message.

**Why:** the two capture paths had drifted (different metadata vocab — even a
conflicting `type` value — and the hook only caught the prompt + final message,
missing intermediate messages / tool calls / reasoning). Reusing the importer
gives parity, completeness, idempotency (deterministic message ids), and one
code path. Incremental + stateless: each fire does one `limit 1` newest-first
search for the session's high-water message (relies on the `orderBy`-desc default
fixed in `e9a6eec`) and writes only the delta; it falls back to the full
reconcile for a new session / `importer_version` bump / lost anchor / write error.

**Maintainer decisions baked in:**

- **Lost prompt-on-submit durability.** Dropping `UserPromptSubmit` means a turn
  that never reaches `Stop`/`SessionEnd` (interrupt-and-quit, kill, API error)
  isn't captured. Narrow: `Stop` fires per turn and re-imports the
  session-so-far, so only the *last in-flight* turn is at risk. Keeping a
  lightweight `UserPromptSubmit` safety-net was rejected — it reintroduces dual
  paths and double-captures the prompt (the live copy has no message id to dedupe
  against the transcript copy).
- **`SessionEnd` in addition to `Stop`** (vs `Stop`-only): a cheap final flush;
  no local state to clean up since the watermark is server-derived.
- **`content_mode` default `"default"`** (user + assistant text). `full_transcript`
  (reasoning + tool calls/results) is an opt-in plugin userConfig — off by default
  because it's much larger/noisier and may capture sensitive tool output.

**How to change it:** the hook command is `me claude hook --event stop|session-end`
([packages/cli/commands/claude.ts]) → `importTranscriptFile`
([packages/cli/importers/index.ts]); registered events live in
[packages/claude-plugin/hooks/hooks.json]. To restore prompt-on-submit capture,
re-add a `UserPromptSubmit` hook (and a dedupe story). To make `full_transcript`
the default, flip the `content_mode` userConfig default in
[packages/claude-plugin/.claude-plugin/plugin.json] (and the hook's
`resolveHookConfigFromEnv`).

**Status:** decided (per request); document the capture model when the docs are
refreshed.
