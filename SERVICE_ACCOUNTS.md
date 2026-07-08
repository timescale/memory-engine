# Service Accounts (`kind='s'`)

> **Status**: Draft / active design. Core shape is now decided (see §3
> Decisions); remaining unknowns live in §8 Open questions and §9 Future work.

## 1. Motivation

Memory Engine today has two credential-bearing principal kinds:

- **User** (`kind='u'`) — a human, authenticated via OAuth (GitHub/Google) →
  a better-auth session (web cookie) or an OAuth 2.1 CLI flow. Globally unique
  name. Can also hold a personal api key (PAT).
- **Agent** (`kind='a'`) — owned by **exactly one** user (`owner_id`). Its
  effective access is clamped to its owner's (`agent_tree_access` →
  `least(agent, owner)` at every path). Authenticates with an api key
  (`me.<lookupId>.<secret>`). Primary use case: coding-agent harnesses (Claude
  Code, opencode, etc.).

(Plus **groups**, `kind='g'` — space-scoped collections of members, used to
grant access and confer admin.)

Both credential holders are ultimately **tied to a single human**: an agent
dies with its owner (removing a user deprovisions the agents it owns). That
single-owner model is exactly wrong for **application / integration / CI-CD**
identities, where a *team* — not an individual — operates a long-lived
automated identity.

### The problem, concretely

**Example 1 — Eon (LLM Slackbot).** Tiger Data runs an LLM-backed Slackbot,
Eon, maintained by a team of engineers. If one engineer creates an agent for
Eon and then goes on vacation (or leaves), **no one else can administer the Eon
identity** — rotate its key, adjust its access — because an agent is owned and
administered by exactly one user.

**Example 2 — docs/commits import GitHub Action.** A GitHub Action that imports
documentation and git commits into Memory Engine on merges to `main` needs an
api key. Tying that key to an individual (or their agent) fails the same way:
when that person leaves, the repo's team cannot administer the integration.

### What's needed

A **top-level principal** that (1) authenticates with an **api key** and (2) is
**administered by a group of users**, so the team retains control regardless of
who created it or who is currently around.

## 2. Proposal: the Service Account

A new principal kind: **service account** (`kind='s'`) — a **space-scoped,
non-human, api-key-bearing** principal, **collectively administered** by a
bound group of users rather than owned by one person. Represents applications,
integrations, bots, and CI/CD pipelines.

### Comparison with existing principals

| Property | User `u` | Agent `a` | Group `g` | **Service account `s`** |
|---|---|---|---|---|
| Human | yes | no | — | no |
| Authenticates with | OAuth session / PAT | api key | (none) | **api key** |
| Governance | self | one owner user | space admins | **bound admin group of users** |
| Access ceiling | its own grants | clamped to owner | — | **its own grants (no clamp)** |
| Global vs space | global | global | space-scoped | **space-scoped** |
| Default access | — | — | — | **none** (zero grants) |
| Can be space admin | yes | no | yes | **no** |

The headline difference from an agent: administration is **detached from a
single human and attached to a group of humans**, and there is **no owner
clamp** — the SA's access is a first-class thing you audit like a top-level
user's.

## 3. Decisions (locked)

- **D1 — Creation is space-admin-only.** Only a space admin (`principal_space.
  admin`, structural authority) can create a service account.
- **D2 — Each SA is bound to a dedicated admin group.** Creating an SA
  atomically creates a `kind='g'` group in the same space and binds it to the
  SA. The group's **members** are the users allowed to administer the SA.
- **D3 — The SA points at its admin group** via a new `principal` column
  (tentatively **`admin_id`**, referencing `principal(group_id)` so the FK
  guarantees it's a group). See §8 for the name bikeshed.
- **D4 — Granting access to an SA uses the ordinary rule: `owner@P`.** No new
  authz primitive. To grant the SA access at path *P*, the grantor needs
  `owner@P` (a space admin has this everywhere). Admin-group members grant using
  their own `owner@P`; a space admin can grant anything.
- **D5 — Grants are sticky.** Access granted to an SA persists even after the
  granting member loses that access or leaves the group/space. This is the
  durability win (integrations don't break when a human leaves) — and the reason
  an SA's access must be **audited like a top-level user's**, not assumed to be
  bounded by any current human.
- **D6 — Revocation is broad.** Space admins **and** any admin-group member may
  revoke access from the SA (revocation only reduces, so it's low-risk).
- **D7 — Admin-group members manage the SA's api keys** (create / rotate /
  revoke), in addition to space admins. Key mint/revoke stays a
  session/OAuth/PAT operation — a key can never mint keys.
- **D8 — The SA's own key is data-plane only.** Like an agent key: it reads/
  writes memory subject to grants but cannot manage grants, keys, or the roster.
  (This prevents an SA from becoming a grant-laundering vector — and see §9 for
  the auto-provisioning use case that will want to revisit exactly this.)
- **D9 — Admin group membership is flexible.** The space admin adds the first
  member(s). Each member may or may not get the group's `group_member.admin`
  flag; with **zero** group-admins, only space admins can change membership. The
  group may be left **empty**, in which case space admins administer the SA
  directly.
- **D10 — The admin group is users-only.** Only `kind='u'` may be added to an
  SA's admin group. No agents (administration is a human trust relationship),
  no SAs.
- **D11 — SA gets zero access by default.** No auto-home grant, and it is
  **not** added to the space's default group. A freshly created SA can
  authenticate but is denied by the empty-`build_tree_access` gate until an
  admin/member grants it something.
- **D12 — An SA *may* be a member of ordinary groups** (distinct from D10's
  admin group). This is a convenient way to grant many SAs access at once, and
  is consistent with agents being group members. An SA inherits an ordinary
  group's grants like any member. (Group-*admin* flag for an SA: leaning no,
  mirroring agents — see §8.)
- **D13 — Lifecycle.** Deleting the SA deletes its bound admin group (and that
  group's `group_member` / `tree_access` / roster rows). The admin group
  **cannot be deleted directly** (delete the SA instead), **cannot be a
  space-admin group**, and **cannot be the space default group** — enforced by
  constraint triggers.

### Accepted limitation (by design)

Because grants require `owner@P` (D4) but the SA has no clamp (no owner) and
accepts grants from *multiple* admin-group members, an SA can accumulate
**broader** access than any single member holds — e.g. two members who each own
disjoint subtrees can each grant the SA their subtree, and members can then use
the SA's key to reach the union. This is **acceptable and intentional**. It is
bounded by: creation is space-admin-only (D1), the space admin picks the first
members and whether any can add more (D9), and it is a deliberate trust
relationship between the space admin and the admin-group members.

## 4. Data model

`core.principal` (`incremental/002_principal.sql`) changes:

- **`kind`** check extends to `('g','u','a','s')`.
- **`member_id`** generated column extends to `kind in ('u','a','s')` so the SA
  can hold api keys (`api_key.member_id` FK) and be an ordinary group member
  (`group_member.member_id` FK, per D12).
- **`space_id`** must be non-null for `s` (space-scoped, like `g`): the check
  becomes `(kind in ('g','s') and space_id is not null) or (kind not in
  ('g','s') and space_id is null)`.
- **`admin_id`** (new) `uuid references principal(group_id)`, with
  `(kind = 's' and admin_id is not null) or (kind != 's' and admin_id is null)`.
- **Name uniqueness**: per-space for `s` (like groups). The bound admin group's
  name is per-space too; likely auto-derived (e.g. `<sa-name>-admins`) — TBD.

The **bound admin group** needs to be distinguishable from ordinary groups to
enforce D10/D13. Options: (a) a back-reference check (`exists (select 1 from
principal where admin_id = <group>)`), or (b) an explicit flag column on the
group principal (cheaper checks, easy constraint exclusions vs. `is_default_
group` / space-admin). Impl detail — §8.

## 5. Administration & authorization

- **Create** (`serviceAccount.create`, space-admin only, one SQL function):
  creates the SA principal (`kind='s'`, `space_id`, `admin_id`), creates + binds
  the admin group, rosters both into the space (`principal_space`), and adds any
  initial member(s) to the group with chosen `group_member.admin` flags.
- **Grant / revoke access to the SA**: grant needs `owner@P` (D4); revoke is
  space-admin *or* any admin-group member (D6). These act on the SA's own
  `tree_access` rows.
- **Manage keys**: admin-group members + space admins (D7); session/OAuth/PAT
  only.
- **Manage admin-group membership**: space admins always; group members holding
  `group_member.admin` (D9). Adding a non-user is rejected (D10).
- **The SA acting**: its key is data-plane only (D8) — `memory.*` clamped to its
  grants; management RPCs fail (same posture as agent keys on the user
  endpoint).

## 6. Access model

- **`build_tree_access` dispatch** (`idempotent/003_tree_access.sql`) gains a
  `kind='s'` branch. No owner clamp, so it resolves like a user: **direct
  `tree_access` grants ∪ grants inherited from ordinary groups** the SA belongs
  to (D12). Either reuse a user-shaped path or add a `service_tree_access`
  helper.
- The space data-plane functions (`search_memory`, `get_memory`, …) need **no
  change** — they still consume the `_tree_access` jsonb.
- Auth gate unchanged: empty effective access ⇒ denied (so D11's zero-grant SA
  is inert until granted).

## 7. Surface area (sketch)

- **API**: `serviceAccount.*` under `/api/v1/user/rpc` (parallels `agent.*`):
  `create` / `list` / `rename` / `delete`, plus admin-group membership ops and
  key management. (Or a generalized principal surface — TBD.)
- **CLI**: a `me service` group (parallels `me agent`) + key management; the key
  is printed once for the operator to place in the CI secret / app config.

## 8. Open questions

1. **`admin_id` naming.** `admin_id` (short, references `principal(group_id)`,
   parallels `owner_id`) vs. the more explicit-but-verbose `admin_group_id`.
   Current lean: **`admin_id`** with a clear column comment.
2. **Bound-group marking**: back-reference check vs. explicit flag column
   (§4). Flag is cheaper and makes the D13 exclusions constraint-friendly.
3. **SA as a *group admin***: D12 allows an SA as a group *member*; should it be
   allowed the `group_member.admin` flag? Leaning **no** (mirror agents), but
   the §9 auto-provisioning use case may want otherwise.
4. **Admin group naming/derivation** and whether it's user-visible/renamable.
5. **`X-Me-As-Service`?** A `X-Me-As-Agent` analogue letting an admin-group
   member act as the SA from their own human credential. Consistent with the
   accepted escalation (they could mint a key anyway) and avoids key handling —
   but scope creep. Deferred.

## 9. Future work

### Auto-provisioning service accounts (needs deep design — todo)

There is a compelling use case for an SA integration that **automatically adds
new company members to a space and provisions their access** (e.g. wired to an
HR/SSO event). This is highly useful but **directly conflicts with D8** (SA key
is data-plane only): such an SA needs **structural admin** (roster mutation) and
**grant authority** through its api key.

Open sub-questions to resolve before committing:

- What authority does such an SA hold, and how is it expressed (a structural-
  admin bit on the SA? bounded grant authority?)?
- Blast radius / guardrails: an SA that can add members and grant access is
  close to a space-admin bot. How do we bound it (e.g. only grant within
  specified subtrees, only add members to specified groups)?
- Does this reopen D8 for a *class* of SAs, or is it a separate capability flag?
- Audit / attribution for actions an SA takes on the roster.

Tracked as a design todo; not in scope for the initial service-account feature.

## 10. Glossary / docs touch-ups on ship

- `AGENTS.md`: `principal.kind` enum, the `member_id` generated-column
  definition, the "Principals, members, spaces" section, and the many
  `kind in ('u','a')` / `kind = 'a'` invariant descriptions.
- `docs/access-control.md`, `docs/concepts.md`: add the service-account
  principal and its admin-group model.
