# Design: Agent provisioning + the public/private capture wizard

**Status:** Partially decided (2026-06-30 meeting). NOT implemented. The
project-scoped **wizard** is specified in `PROJECT_CONFIG_DESIGN.md` §3a (it ships
with the `.me/` work). This document owns the agent-acquisition **mechanics**, the
**server changes** they require, and the **team-defaults** mechanism.

## Credential model (revised at the meeting)

The default path **does not store an agent key**. Instead:

- **Default (cooperative):** reuse the human's authentication and send
  **`X-Me-Agent: <agent-id>`** (agent id from committable `.me/config.yaml`). The
  server authorizes as that owned agent, clamped to the human. No secret in `.me/`.
- **Sandbox (untrusted):** the harness runs with **`ME_API_KEY` = an agent key**
  and no user credentials; the key authenticates *as* the agent and **`X-Me-Agent`
  is ignored** (an agent-issued key trumps the agent header; a user PAT lets
  `X-Me-Agent` apply).

`.me/credentials.yaml` was dropped. Provisioning therefore **creates/adds/grants
an agent and records its id** — it does not mint-and-store a key for the default.

## Verified access facts (this repo, 2026-06-30)

- **`~` is principal-relative, server-side** (`path.ts:78-82`, `support.ts:46-48`):
  user → `home.<user_id>`; **agent → `home.<owner_id>.<agent_id>`** (its own nested
  home). An agent **auto-owns its nested home** (`006_membership.sql:52-56`).
- **`agent_tree_access` clamps** effective access to the intersection of the
  agent's grants and its owner's (`003_tree_access.sql:62-136`) — this is what
  makes "grant the agent broadly, it still can't exceed you" safe.
- **Self-service (no admin):** adding *your own* agent to a space
  (`memory/principal.ts` `callerOwnsAgentGlobal`) and granting *your own* agent at
  a path (`grant.ts` `requireGrantAuthority` → `callerOwnsAgent`). **Admin-gated:**
  adding an agent to a **group** (`group.ts` `groupAddMember` → `requireGroupAdmin`).
- **No cascade:** a user joining a space never enrolls their agents (each is added
  explicitly, one `principal_space` row).
- **Discrepancy to verify — `read@share` default.** The meeting assumed members
  get `owner@home` **+ `read@share`**; exploration found only `owner@home`
  (`006_membership.sql:50-61`), with `share` granted only via an invite's
  `share_access` (`009_invitation.sql:111-112`) or the creator's explicit
  `owner@share` (`provision.ts:34-41`). Resolve this — it decides whether public
  transcripts are readable by all, and is bound up with the default-group work.

## Wizard mechanics (step 4: agent)

Self-service, no admin, no key:
1. create a new agent (default name = repo slug) **or** pick an existing one;
2. `principal.add` the agent to the chosen space;
3. **grant the agent broadly by default** so it "acts like you" (clamped to the
   human) — see grant level below;
4. record the agent id in `.me/config.yaml` (the `X-Me-Agent` value). Idempotent.

For the **public** capture path (`share/projects/<repo>`), the wizard also
suggests the user's write+ roots (`grant.list` / `me access mine`, filtered
≥ write) and lets them pick one or a subtree; it must be writable by the user
(the agent is clamped to the user). For the **private** path (`~/projects/<repo>`
= the agent's own home) no grant is needed — the agent auto-owns it.

## Default agent grant level (decided direction)

**Default ≈ the human** — the provisioned agent is granted broadly (clamped to the
human, so it can never exceed you), i.e. it "acts like you" out of the box.
Constraining the harness is **opt-in**: reduce the agent's grants afterward. This
favors low-friction first use (Mat/Justin); the earlier "tight `write@<project>`"
lean is dropped as the default.

## Server changes this requires

1. **`X-Me-Agent` header** (analogous to `X-Me-Space`): authenticate the human,
   authorize as the named agent the human owns (clamped). Ignored when the bearer
   is an agent-issued key.
2. **Setting an agent's own grants must not require space `owner`** — you should
   be able to constrain/grant *your own* agent with only your own authority (it's
   clamped to you anyway). (Exploration shows `grant.ts` already self-services
   `callerOwnsAgent`; confirm no other path — e.g. the underlying core grant —
   still demands owner, and fix if so.)

## Team defaults: editable default group

Rather than hardcode join grants, a per-space **default group** (from the invites
rework) carries them, and an admin can **edit** the default group's grants. This
is how a team opts members into e.g. write on `share.projects` — making the
**public** capture path viable without a per-member fixup, and undoable (edit the
group) unlike a hardcoded default. The current hardcoded grants (`owner@home`, and
whatever `share` access) move into this group.

## Other open questions

- **Key lifecycle (sandbox path):** how a sandboxed agent key is issued/rotated/
  revoked (out-of-band via `ME_API_KEY`; not stored by `me`).
- **Per-project agent vs reusable agent:** wizard defaults to create-new
  (name = repo slug), allows pick-existing.
- **Tree-root mapping** (shared with the `.me/` doc): store `~/projects` + append
  the slug, or store the full project path and append only `agent_sessions`.
- **Rendering agent homes** as `<agent-name>` instead of the UUID in the tree
  (nice-to-have; not implemented).

## Dependencies / references

- Paired with: `PROJECT_CONFIG_DESIGN.md` (`.me/` resolution, agent mode via
  `X-Me-Agent`, the §3a wizard).
- Related in-flight: the invites rework (magic links + accept-invites, then
  scope-invite-to-group + default group).
- Code: `agent.*` / `apiKey.*` RPCs (`commands/agent.ts`, `apikey.ts`); grants
  (`server/rpc/memory/grant.ts`, `core.grantTreeAccess`); membership
  (`add_principal_to_space`, `006_membership.sql`); clamp
  (`003_tree_access.sql` `agent_tree_access`); `~` expansion
  (`packages/database/space/path.ts`).
