# Service Accounts (`kind='s'`)

> **Status**: Draft / active design. Core shape is now decided (see §3
> Decisions); remaining unknowns live in §8 Open questions and §9.7 Remaining
> questions.

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

**Example 3 — auto-provisioning service.** A company wants an integration wired
to HR/SSO events that invites new employees to the right Memory Engine space and
puts them in the right groups automatically. This integration needs durable
structural authority (issuing invites, managing selected group rosters, perhaps
granting access in bounded subtrees), but it is a traditional deterministic
program owned by the workspace/team — not a human user and not one engineer's
agent.

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
| Can be space admin | yes | no | yes | **allowed, discouraged** |

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
- **D8 — The SA's own key has no authority by default.** A freshly created SA is
  inert (D11). Once granted authority, its key may exercise that authority like
  any other principal: `tree_access` for memory access, `owner@P` for grant
  management under *P*, `group_member.admin` for managing that group's roster,
  `can_invite` for invitation creation (§9), `can_deprovision` for space
  offboarding (§9), and `principal_space.admin` if the operator explicitly makes
  the SA a space admin (D14). Key mint/revoke stays human-administered: an SA
  key can never mint keys.
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
  group's grants like any member. It may also hold `group_member.admin` on
  ordinary groups, which is useful for provisioning (§9).
- **D13 — Lifecycle.** Deleting the SA deletes its bound admin group (and that
  group's `group_member` / `tree_access` / roster rows). The admin group
  **cannot be deleted directly** (delete the SA instead), **cannot be a
  space-admin group**, and **cannot be the space default group** — enforced by
  constraint triggers.
- **D14 — Space-admin SAs are allowed but discouraged.** We should not block an
  operator from explicitly giving an SA `principal_space.admin`; some traditional
  deterministic integrations may legitimately need broad structural authority.
  This is reckless for LLM-held keys and should not be the normal provisioning
  path. If an SA is made a space admin, `principal_space.admin` should mean the
  same thing it means for users, except for the still-open `space.delete` carve-
  out (§8).

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
- **The SA acting**: its key may exercise explicit authorities assigned to the
  SA (D8): memory access from `tree_access`, grant authority from `owner@P`,
  group-roster management from `group_member.admin`, invitations from
  `can_invite`, and broad structural authority from explicit space-admin status
  (D14). It still cannot mint/revoke api keys.

## 6. Access model

- **`build_tree_access` dispatch** (`idempotent/003_tree_access.sql`) gains a
  `kind='s'` branch. No owner clamp, so it resolves like a user: **direct
  `tree_access` grants ∪ grants inherited from ordinary groups** the SA belongs
  to (D12). Either reuse a user-shaped path or add a `service_tree_access`
  helper.
- The space data-plane functions (`search_memory`, `get_memory`, …) need **no
  change** — they still consume the `_tree_access` jsonb.
- **Endpoint admission must be based on `principal_space`, not
  `build_tree_access`.** The current memory RPC auth gate incorrectly denies the
  entire `/api/v1/memory/rpc` endpoint when `build_tree_access` is empty. That is
  a pre-existing bug, not a service-account design constraint. Tracked as
  [TNT-200](https://linear.app/tigerdata/issue/TNT-200/fix-memory-rpc-auth-gate-space-membership-must-come-from-principal).
  The intended model is: `principal_space` decides whether a principal belongs
  to a space; `tree_access` decides whether it can access a tree path. A freshly
  created SA with zero tree grants is a valid space member but has no data
  access until granted.

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
3. **SA as a *group admin***: **resolved — yes.** D12 allows an SA as a group
   *member*; it may also hold and exercise `group_member.admin` on ordinary
   groups. This is distinct from inviting new users into the space: a service
   account can manage an existing group's roster without being allowed to create
   space invitations. (Requires allowing `kind='s'` in the group-admin logic
   that currently strips agents: `gm.admin and not m.kind = 'a'`.)
4. **Admin group naming/derivation** and whether it's user-visible/renamable.
5. **No `X-Me-As-Service`.** Rejected. Service accounts authenticate and
   authorize with their own api key via `ME_API_KEY` or `--api-key`; there is no
   human-credential "act as service" mode.
6. **SA space-admin delete restriction**: if an SA is deliberately made a space
   admin (D14), should its api key still be barred from `space.delete`? Current
   lean: yes — space deletion is catastrophic and not a normal integration task.

## 9. Auto-provisioning service accounts

A compelling extension: an SA integration that **automatically adds new company
members to a space and provisions their access** (e.g. wired to an HR/SSO
event — new hire joins → they land in the right groups with the right grants).
This *appears* to conflict with D8 (SA key has no authority by default), because
it needs roster + grant management through an api key. The tension resolves
cleanly once the actions are decomposed into existing, already-bounded
primitives.

> Status: designed here, **not in scope for the initial feature**. Ships as a
> follow-on capability once the base SA lands.

### 9.1 You cannot fabricate a human

A user principal only exists **after** the human authenticates (OAuth login).
So *nobody* — not even a space admin — conjures a member from nothing: new
people are admitted via **invitations** that the invitee redeems on login. The
SA is no different. Auto-provisioning is therefore:

> the SA **issues an email invitation** (encoding the target groups) → the new
> hire logs in and **redeems** it → they land provisioned.

Human-in-the-loop is *inherent*, not a restriction we add. The invite row is the
bounded carrier: privileges (admin flag, groups) are read from the row at
redemption and "no caller can join a user with more access than the invitation
specifies" (`_join_via_invitation`).

### 9.2 Primitive decomposition

| Action | Primitive today | Gate today | Natural bound |
|---|---|---|---|
| Admit a human | `invite.create` → redeem | space-admin | invite encodes groups/admin; human authenticates |
| Put in groups | invite `group_ids`; `group.addMember` | space-admin **or** `group_member.admin` | `group_member.admin` is **per-group** |
| Remove / offboard a human | `principal.remove`; `group.removeMember` | space-admin, or group-admin for group removal | group removal is per-group; full space removal is broad |
| Grant access | `grant.set` | `owner@P` | **subtree-scoped** |

Two of the four (`group_member.admin`, `owner@P`) are **already** scoped
primitives. Invite-issuance and full space removal are broader structural acts,
so those need explicit capability bits if exposed to a non-space-admin SA.

### 9.3 Space admin is not the normal path

Because two legs are already bounded, a provisioning SA **does not need
`principal_space.admin`**. The normal supported path is **not** "make the SA a
space admin"; it is "give the SA the exact scoped authorities it needs":
subtree ownership, group-admin memberships, and (only if it must admit new
people) `can_invite`. We do not categorically forbid `principal_space.admin` on
an SA (D14), but it is an explicit operator choice with a much larger blast
radius.

### 9.4 The model: distinct authorities, not one provisioning flag

Do **not** tie all provisioning behavior to one coarse flag. These operations
are distinct and should be granted independently:

- **Grant management**: an SA that holds `owner@P` may call `grant.set` /
  `grant.remove` under *P*, using the ordinary `requireGrantAuthority` rule.
- **Group roster management**: an SA that holds `group_member.admin` on group G
  may add/remove/list members of G. This does **not** imply it can invite new
  people into the space.
- **Invitation creation**: a separate **space-admin-set** `can_invite` flag lets
  an SA create invitations. This is a new capability bit because invitation
  creation otherwise has only an all-space-admin gate.
- **Space offboarding**: a separate **space-admin-set** `can_deprovision` (name
  TBD) flag may let an SA remove users from the space. This is distinct from
  `can_invite`; adding people and removing people have different blast radii.
  Group-level offboarding does not require this flag: `group_member.admin` is
  enough to remove a member from that specific group.
- **Key management**: still never. An SA key cannot mint/revoke api keys.

So the grants/memberships/capability bits are the leash. Examples:

- An SA with `group_member.admin` on `engineering` but `can_invite=false` can
  maintain the `engineering` roster for already-admitted principals, but cannot
  invite new users into the space.
- An SA with `owner@share.eng` but no group-admin can grant/revoke access under
  `share.eng`, but cannot manage any group roster or invite anyone.
- An SA with both `can_invite=true` and group-admin on `engineering` can issue
  non-admin invitations into `engineering`.
- An SA with `can_deprovision=true` can offboard users from the space according
  to the deprovisioning guardrails (§9.5). Without it, it can still remove users
  from groups where it is group-admin, but cannot remove them from the space.

### 9.5 Hard guardrails

- **Non-space-admin `can_invite` invites forced `admin=false`.** A
  non-space-admin SA using `can_invite` can never issue an admin invite — the
  escalation stopper for scoped provisioning. If the operator explicitly makes
  the SA a space admin (D14), normal space-admin invitation semantics apply.
- **Non-space-admin `can_invite` `group_ids` ⊆ groups the SA admins.** No
  inviting into groups outside its leash. (Alternative: an explicit per-SA
  provisioning-group whitelist; `group_member.admin` is preferred as it reuses
  an existing primitive and keeps "can invite into G" ≡ "can manage G".)
- **`can_invite` is space-admin-only to set.** Admin-group members — who can
  already grant the SA `owner@P` they hold (D4) and manage its keys (D7) —
  **cannot** flip `can_invite`. Letting an SA admit new people into the space is
  a deliberate space-admin decision.
- **`can_deprovision` is space-admin-only to set.** Letting an SA remove users
  from the space is at least as sensitive as admitting them. Initial lean: a
  non-space-admin SA with `can_deprovision` may remove non-admin users, but not
  admins; if the operator explicitly makes the SA a space admin (D14), normal
  space-admin removal semantics apply. `enforce_last_admin` is still the DB
  backstop either way.
- **`enforce_last_admin` still applies** for any path that can remove or demote
  admins. A non-space-admin provisioning SA is not counted as an admin.

### 9.6 Blast radius (leaked provisioning-SA key)

For a non-space-admin provisioning SA, bounded to the independent authorities it
holds: issuing non-admin invites into its admin-able groups (only if
`can_invite=true`), churning groups where it is group-admin, and
granting/revoking within its owned subtrees, and offboarding non-admin users
only if `can_deprovision=true`. It **cannot** mint a space admin, exceed its
owned subtrees, touch groups it doesn't admin, mint keys, or delete the space.
Fully recoverable by revoking the key.
Attribution is free: SA-issued invites carry `invited_by = <SA principal>` and
redemptions are logged (`space_invitation_redemption`).

### 9.7 Remaining questions

- **Direct-add variant**: should `can_invite` also allow `principal.add`
  of an *already-existing* user (skipping the redeem step) into admin-able
  groups, non-admin? More convenient, less human-in-the-loop. Lean: invite-first
  by default; consider as a separate sub-capability.
- **Audit depth**: invites are attributed already; do we want an explicit audit
  trail for SA-initiated `group.addMember` / `grant.set` given the elevated
  capability?
- **Invite management scope**: can an SA with `can_invite` list/revoke all
  pending invitations into groups it admins, or only invitations it created?
- **Deprovisioning scope**: if `can_deprovision` exists, should it remove any
  non-admin user, only users invited by this SA, only users in groups it admins,
  or only users matching an external identity-domain/policy? The useful HR-sync
  version likely needs broad non-admin removal, but provenance-bounded removal is
  safer.

## 10. Glossary / docs touch-ups on ship

- `AGENTS.md`: `principal.kind` enum, the `member_id` generated-column
  definition, the "Principals, members, spaces" section, and the many
  `kind in ('u','a')` / `kind = 'a'` invariant descriptions.
- `docs/access-control.md`, `docs/concepts.md`: add the service-account
  principal and its admin-group model.
