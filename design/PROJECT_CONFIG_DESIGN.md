# Design: Project-local `.me/` config + agent mode (scoping-by-default)

**Status:** Proposal (not yet implemented). Reflects the 2026-06-30 design meeting.
**Date:** 2026-06-29 (updated 2026-06-30 post-meeting)
**Context:** Follow-up to the OpenCode integration parity work (PR #115). This is a
sizable, CLI-wide change to how `me` resolves credentials, so it is written up
for review rather than built immediately.
**Scope note:** This design covers credential *resolution* + *agent mode* +
*integration wiring*. **Agent provisioning** (creating/adding/granting the agent)
is a separate design — `AGENT_PROVISIONING_DESIGN.md`.

**Post-meeting revision (2026-06-30):** the credential model changed. Agent mode
no longer stores an agent **API key** in `.me/`; instead it reuses the human's
authentication and applies the agent's authorization via a new **`X-Me-Agent`**
header (the agent id, non-secret, lives in `.me/config.yaml`). A stored agent key
is only for a **sandboxed** harness (`ME_API_KEY`). **`.me/credentials.yaml` is
dropped** — the default path stores no secret. Sharing is no longer deferred: the
wizard asks **public vs private**.

---

## 1. The problem(s)

The coding-agent integrations (OpenCode today; Claude Code / Codex on the same
pattern) shell out to the `me` CLI for two things: running the MCP server
(`me mcp`) and capturing sessions (`me <agent> hook`). Both resolve their
**server**, **space**, and **bearer** at runtime from `resolveCredentials`
(`packages/cli/credentials.ts`), which reads **shared, mutable, global** state:

```ts
server:      --server > ME_SERVER > config.default_server > DEFAULT_SERVER
activeSpace: ME_SPACE > config.active_space          // ~/.config/me/config.yaml
apiKey:      ME_API_KEY                               // never persisted today
```

This produces three concrete problems for a developer who runs **multiple
projects with multiple agents simultaneously** (and also uses the `me` CLI
interactively):

1. **Cross-project space bleed (the headline problem).** `me space use B` in any
   terminal rewrites the *global* `active_space`. Because the integration resolves
   space at runtime from that global value:
   - the **capture hook** runs fresh on every `session.idle` / `session.deleted`,
     so project A's *next* capture can suddenly write to space B;
   - a newly launched OpenCode instance's **MCP server** binds to whatever the
     global active space happens to be at startup.
   The user wants project A's sessions to *always* write to space A, immune to
   what any other terminal/agent does.

2. **No per-project agent identity / no way to constrain the harness.** The
   default bearer is the human's `me login` session, so the agent acts *as the
   human* with the human's full authority — e.g. a harness that shells out to the
   CLI could delete the whole space. Memory Engine has first-class **agent
   principals** (`principal.kind = 'a'`, per-agent home trees) precisely so an
   agent can be its own, separately-constrainable identity. The point of the
   integration is to let you **optionally constrain the harness** without
   constraining yourself.

3. **No project-scoped configuration surface.** There is exactly one global
   config (`~/.config/me/`). There is nowhere to record "in this repo, use this
   server + this space (+ this agent)" that travels with the project and can be
   shared with a team.

Non-goal / explicitly fine: a human running `me` interactively should keep using
their own session. We only want the *routing* (server/space) to be stable
per-project and the *automated* paths to act as an agent.

---

## 2. Options considered

### Option A — Pin `--server`/`--space` into the per-project integration files
Bake `--space A --server X` into the project's `opencode.json` (`mcp.me.command`)
and into the generated capture plugin's `me … hook` invocation.

- **Pro:** small, leverages the just-shipped `--scope` work; no core changes.
- **Con:** only fixes the integration, not interactive `me`; duplicates the
  pinned values across two files; doesn't address identity/attribution; baking an
  agent key into a committed file would leak a secret. Partial fix.

### Option B — Project-local `.me/` config, CLI-wide (chosen)
A `.me/` directory at the repo root, discovered by walking up from cwd, that
overrides the global config for **all** `me` commands run in that tree.
`.me/config.yaml` is non-secret (server + space + capture tree + the project's
**agent id**) and **committable**. There is **no** `.me/credentials.yaml` — see
the credential model below.

- **Pro:** fixes routing for the integration *and* interactive `me` in the
  project; one place for project identity; composes with project-scope integration
  files; **no stored secret**.
- **Con:** a real change to core credential resolution; introduces a new config
  surface; needs a new server-side `X-Me-Agent` header.

### Agent-vs-human selection — sub-options
How do we decide when a `me` invocation acts as the agent vs the human?

- **B1 — `--use-session` opt-out:** agent by default, flag to fall back. Verbose.
- **B2 — TTY heuristic:** treat a TTY as human, no-TTY as agent. Rejected — a
  *heuristic* with false positives both ways (human piping `me search | jq`; agent
  runners with PTYs). Spooky/non-debuggable.
- **B3 — explicit `--agent` / `ME_AGENT` mode (chosen):** agent mode is set
  explicitly. We control the integration commands, so we bake `--agent` into them;
  for the agent's own ad-hoc `me` calls we inject `ME_AGENT=1` into its tool
  shells via each harness's env mechanism (OpenCode `shell.env`, Claude
  `settings.json` env, Codex `shell_environment_policy`, Gemini `.gemini/.env` —
  see the per-harness table in §3). Deterministic, debuggable, no heuristic.

### Credential model (revised at the 2026-06-30 meeting)
Rather than store an agent key in the project, agent mode **reuses the human's
authentication** and applies the **agent's authorization** via a new
**`X-Me-Agent: <agent-id>`** header (analogous to `X-Me-Space`). The server
authenticates the human, then authorizes as the named agent the human owns
(effective access is the agent's grants clamped to the human — the existing
`agent_tree_access` clamp). The agent id is non-secret and lives in committable
`.me/config.yaml`, so **the default path stores no secret**. A real agent key is
used only for a **sandboxed** harness (via `ME_API_KEY`), where the key
authenticates *as* the agent directly. This dropped `.me/credentials.yaml`.

`--config-dir` (locating `.me/`): support **both** cwd discovery (portable,
committable) and an explicit `--config-dir <abs>` / `ME_CONFIG_DIR` (robust when
the MCP server's cwd isn't the project). Deferrable (see open items).

---

## 3. The proposed change

Adopt **Option B with B3** (explicit `--agent` mode): project-local `.me/`, a
CLI-wide credential-resolution feature. Agent mode reuses the human's auth and
adds an `X-Me-Agent` header naming the project's agent. **Scope:** this design
covers *resolution* + *agent mode* + *integration wiring*. It does **not** specify
how the agent is created/added/granted — that is a **separate design** (see §3a).

### Files
- `.me/config.yaml` — **non-secret, committable**: `default_server`, per-server
  `active_space`, the project's capture **`tree`** (e.g. private default
  `~/projects/<repo>`), and the project's **`agent`** id (the `X-Me-Agent` value).
- **No `.me/credentials.yaml`.** The default path stores no secret; a sandboxed
  harness supplies an agent key via `ME_API_KEY` (not a file).

### Resolution rule
Compute an `agent` boolean from `--agent` / `ME_AGENT`. Then:

- **server** (both modes): `--server` > `ME_SERVER` > `.me/` `default_server` >
  global `default_server` > `DEFAULT_SERVER`
- **space** (both modes): `--space` > `ME_SPACE` > `.me/` `active_space` >
  global `active_space`
- **bearer + role:**
  - `ME_API_KEY` set → it is the bearer, highest priority. If it is an **agent
    key**, it authenticates *as* that agent and **`X-Me-Agent` is ignored** (the
    sandbox path — the key already is the agent). If it is a **user PAT**,
    `X-Me-Agent` applies normally (below).
  - else the bearer is the human's **`me login` session** (keychain / `~/.config/me`).
  - **`X-Me-Agent`:** in **agent mode** (`--agent` / `ME_AGENT`), the CLI sends
    `X-Me-Agent: <.me/ agent id>` so the server authorizes as that owned agent
    (grants clamped to the human). In **non-agent** mode no agent header is sent —
    the human acts as themselves. Error if agent mode is set but `.me/config.yaml`
    has no `agent` id.

Routing (server/space) is shared by humans and agents — this is what kills the
space race. Only the *agent header* is gated by `--agent`. `.me/` is inert when
absent, so existing users see no behavior change. There is **no `--user` flag**:
the human is simply the one *without* the marker.

Precedence overall: **flag > `ME_*` env > `.me/` > global.**

### Discovery + `me space use`
`findProjectConfigDir(cwd)` walks up to the nearest ancestor `.me/`, stopping at
the git root / filesystem root. `--config-dir <path>` / `ME_CONFIG_DIR` forces a
specific dir (skips the walk); deferrable — cwd discovery is sufficient when the
harness runs in the project dir.

Config-mutating commands (`me space use`, server/default changes) **edit the
project `.me/config.yaml` when inside a `.me/` tree**, else the global config —
the standard local-then-parent-then-home hierarchy. (Exact hierarchy is a detail
to settle in implementation.)

### 3a. `me <harness> init` — project-scoped provisioning wizard

`me <harness> init` is **project-scope only** (it writes into the repo; there is
no `--scope` on `init` — that flag stays on `me <harness> install`). It runs as a
**wizard by default**, with **flags mirroring every prompt** for headless/CI use.

Architecturally it is a **shared, harness-agnostic provisioning wizard** (which
produces `.me/`) **+ a per-harness wiring step**. A second harness's `init` in the
same repo reuses the existing `.me/` and only adds its own wiring.

**Public vs private is an explicit prompt — no silent default** (meeting decision;
Justin: surprising to silently share transcripts). The wizard asks public/private
and then offers an editable default path:

- **Private** → **`~/projects/<repo>`**. `~` is principal-relative and resolves
  *for the capturing agent* to its own nested home `home.<owner>.<agent>` — private
  to the owner (whose `owner@home.<owner>` covers it), invisible to other members.
  The agent **auto-owns its home**, so private needs **no grant, no write-validation,
  no tier logic**.
- **Public** → **`share/projects/<repo>`** (shared with the space). This needs the
  user to have **write** at that path, so the wizard suggests the user's writable
  roots (`grant.list` / `me access mine`, filtered ≥ write) and lets them pick one
  or a subtree, and the agent gets a grant there (clamped to the human). Public
  becomes practical once a team configures its **default group** (see below) to
  grant members write on `share.projects`.

The wizard's four steps:
1. **Server** — default the logged-in server.
2. **Space** — pick from the user's spaces (the agent must be added to *a* space;
   captures live within that space).
3. **Public/private → tree** — the prompt above; stored in `.me/config.yaml`.
4. **Agent** — new (default name = repo slug) or existing → `principal.add` to the
   space → record the agent id in `.me/config.yaml` (the `X-Me-Agent` value). **No
   key is minted or stored** (agent mode uses the human's auth + `X-Me-Agent`); a
   key is only needed for a sandboxed harness (`ME_API_KEY`).

**Default agent access ≈ the human, constrain later (opt-in).** By default the
provisioned agent is granted broadly (e.g. matching the user), so — clamped to the
human — it simply "acts like you"; a user who wants to constrain the harness tightens
the agent's grants afterward. (Setting an agent's grants needs owner-on-your-*own*
authority, not space owner — a server tweak tracked in the provisioning design.)

**Team defaults via an editable default group** (Mat's invites work): the hardcoded
join grants (`owner@home`, and read on `share`) move into a per-space **default
group** whose grants an admin can edit — this is how a team opts members into write
on `share.projects` (making the public path viable) without a per-member fixup.

### Integration wiring

Agent mode is conveyed two ways; both are **cooperative-scoping convenience**
(do-the-right-thing by default), not a containment boundary (see Threat model).
"Agent mode" means the CLI sends `X-Me-Agent: <.me/ agent id>` on top of the
human's auth:

- **Authored commands carry `--agent`.** We author the MCP server command and
  the capture-hook command, so both carry `--agent` explicitly — reliable on
  every harness for the agent's primary memory access (MCP tools) and captures.
- **`ME_AGENT=1` injected into the agent's tool shells (per-harness).** So the
  agent's *ad-hoc* `me` calls (the intended long-tail CLI surface) also run in
  agent mode. Each harness has a mechanism (table below). If injection is missing
  (half-configured setup), the ad-hoc call falls back to acting as the human —
  acceptable cooperative degradation, since containment is the sandbox's job, not
  this marker's.

We no longer bake server/space into integration files; identity lives in `.me/`.
Everything committed is **non-secret**: `.me/config.yaml` (server/space/tree/agent
id) and the harness markers (`ME_AGENT=1`). There is **no stored key** — the
default path uses the human's auth + `X-Me-Agent`; a sandboxed harness supplies an
agent key out-of-band via `ME_API_KEY`.

#### Per-harness mechanisms (verified against current docs, 2026-06-30)

**Every capability we rely on is supported on all four harnesses.** In the table,
**✅ = capability present** (with the mechanism in parentheses); the *Project
config dir* column is descriptive (it names *where* config lives, not a yes/no).
Of the capability columns, only **Tier‑1** is required-and-universal; **MCP‑env**
is an optional alternative (we already convey agent mode via `--agent` in the
command args, so MCP‑env isn't needed).

| Harness | Tier‑1: `--agent` in MCP + hook cmds *(required)* | MCP server `env` *(optional)* | Tier‑2: inject `ME_AGENT` into agent shell | Hooks (capture) | Project config dir |
|---|---|---|---|---|---|
| **OpenCode** | ✅ (we author the command + plugin) | ✅ `environment` on local MCP config | ✅ `shell.env` plugin hook (dynamic) | ✅ plugin hooks (`session.idle`, …) | `.opencode/` |
| **Claude Code** | ✅ (`.mcp.json` / hook commands) | ✅ `.mcp.json` `env` | ✅ `settings.json` `env` (`.claude/settings.json` committed / `settings.local.json` auto-gitignored) | ✅ settings/plugin hooks (Stop, SessionEnd, …) | `.claude/` |
| **Codex** | ✅ (`mcp_servers.<id>.args`) | ✅ `mcp_servers.<id>.env` | ✅ `[shell_environment_policy] set = { ME_AGENT = "1" }` | ✅ `features.hooks` (`SessionStart`/`Stop`/`UserPromptSubmit`/…) | `.codex/config.toml` (trust-gated) |
| **Gemini** | ✅ (`gemini mcp add` args) | ✅ `mcpServers[].env` (+ `$VAR` interpolation) | ✅ `.gemini/.env` (`ME_AGENT=1`; `.gemini/.env` vars never excluded) | ✅ hooks (overview + reference) | `.gemini/` |

Notes:
- **Codex** gained first-class **lifecycle hooks** *and* **project-scoped
  `.codex/config.toml`** since our April/May spike, so the old "PluginHooks under
  development" caveat is gone — Codex can do live capture like the others. Its
  shell-env injection can be global (`~/.codex/config.toml`) since Codex *is* the
  agent; routing stays per-project via `.me/`.
- **Gemini** loads `.env` from cwd upward to the git root (then `~/.env`);
  `.gemini/.env` is the recommended, never-excluded home for `ME_AGENT`. Gemini
  also redacts *secret-looking* env vars from tool execution — fine here, since
  `ME_AGENT` is a non-secret marker (no key is passed via env in the default path).
- **Claude** `settings.local.json` is auto-gitignored, a natural home for
  `ME_AGENT` (and per-developer overrides) without committing it.

All four also expose project-scoped **MCP registration, hooks, skills, and
custom commands**, so the full OpenCode integration surface (capture + MCP +
recall command + skill + memory pointer) generalizes to each.

One wrinkle: a harness's *built-in* terminal inherits the injected `ME_AGENT`
(e.g. OpenCode's `shell.env`, Claude's settings `env`), so a human running `me`
there acts as the agent. A separate OS terminal is unaffected. Minor; documented.

### Threat model & isolation (what `me` does and does not defend)

`me` provides **scoping-by-default for a *cooperative* agent**, not containment
of a malicious one. This is a deliberate, accepted boundary:

- **What `me` does:** makes the scoped agent the default / path of least
  resistance whenever the agent acts (MCP, hooks, ad-hoc CLI carry `--agent` /
  `ME_AGENT` → `X-Me-Agent`), so normal long-tail work stays in the agent's
  (clamped) authorization and doesn't *accidentally* use the human's full authority.
- **What `me` cannot do:** contain an agent that runs arbitrary shell as the
  human's OS user. Such an agent could drop `ME_AGENT`/`X-Me-Agent`, read the
  keychain / `~/.config/me` directly, or `curl` the API with the human token —
  none of which any CLI flag can prevent. So `--agent`/`ME_AGENT` is convenience,
  not a guard.
- **The real, enforced boundary is two things, both outside CLI-flag logic:**
  1. **Server-side: the agent's tree-access grants.** Even arbitrary CLI use is
     capped at the agent's grants (clamped to the human) — the **default grant
     level** (in the provisioning design) is the security-critical decision.
  2. **Possession / isolation: a truly contained agent runs in a dedicated
     sandbox provisioned with *only* its api key and no user credentials.** Then
     there is nothing to escalate to. This is the harness's sandbox responsibility,
     not `me`'s.

### Policy / safety
- **No stored secret in `.me/`** — the default path uses the human's auth +
  `X-Me-Agent`; a sandboxed harness supplies an agent key via `ME_API_KEY`
  out-of-band. So `.me/config.yaml` is fully committable and there is no
  `.me/credentials.yaml` to gitignore.
- The injected marker `ME_AGENT=1` and the `.me/config.yaml` `agent` id are both
  non-secret (safe to commit).
- No change to the "API keys are never persisted" policy — this design does not
  persist any key.

---

## 4. Reasoning for the choice

- **Fixes the headline problem at the right layer.** The space race is a
  credential-resolution problem, so the fix belongs in credential resolution
  (`.me/`), not bolted onto each integration. Option A only patched the
  integration and left interactive `me` and identity unaddressed.

- **No stored secret; the default "just works."** Reusing the human's auth +
  `X-Me-Agent` means the default path stores nothing secret (agent id is
  non-secret), so `.me/config.yaml` is committable and there's no key-in-a-file to
  guard. The autoprovisioned agent defaults to the human's authority (clamped), so
  it "acts like you" out of the box; constraining it is opt-in.

- **Explicit `--agent` beats the TTY heuristic.** TTY detection is a guess with
  real false-positives both ways (humans piping output; agent runners with PTYs).
  An explicit flag/env is deterministic; because we author the integration
  commands we set it ourselves, and per-harness env injection (OpenCode
  `shell.env`, Claude `settings.json` env, Codex `shell_environment_policy`,
  Gemini `.gemini/.env`) extends it to the agent's ad-hoc CLI. `ME_API_KEY` is
  always honored (PATs are a human credential); an **agent-issued** key trumps
  `X-Me-Agent` (it *is* the agent — the sandbox path), while a **user PAT** lets
  `X-Me-Agent` apply. No `--user` escape hatch: the human is simply the party
  without the marker.

- **Scoping, not containment — honestly scoped.** We do not pretend `me` flags
  contain a malicious/injected agent (they can't — see Threat model). The enforced
  boundary is the agent's server-side grants plus, for untrusted agents, a
  credential-absent sandbox. This keeps the client side *simple*: no fail-closed
  gymnastics, no `--user`, no stored key.

- **The space race is fixed uniformly across harnesses; agent mode layers on
  top.** Routing (server/space) comes from `.me/` for any `me` invocation in the
  project tree. Agent mode (the `X-Me-Agent` header) is the orthogonal convenience.

- **Shipping separately from #115** keeps the parity PR focused and lets this
  larger core change get its own review.

### Costs we accept
- A new config surface + a new server-side `X-Me-Agent` header (and a tweak so
  setting an agent's own grants doesn't require space owner).
- cwd discovery depends on the harness's cwd; `--config-dir` / `ME_CONFIG_DIR` is
  the (deferrable) robustness escape hatch.
- The agent-mode marker also reaches a harness's *built-in* terminal, so a human
  running `me` there acts as the agent (a separate OS terminal is unaffected) —
  minor, documented.
- Agent mode is cooperative convenience, not containment: a missing injection (or
  a non-cooperative agent) falls back to acting as the human — acceptable, because
  real containment is the sandbox + the agent's grants, not this marker.

### Open items (decide at implementation)
1. **`--config-dir` / `ME_CONFIG_DIR`:** likely deferrable — ship cwd discovery
   first, add the explicit override only if a harness proves it necessary.
2. **Tree-root mapping:** the shipped importer lays captures out as
   `<tree_root>.<project_slug>.agent_sessions`. With `.me/`, the wizard's project
   tree is `~/projects/<repo>` — decide whether to store the root `~/projects` and
   let the slug append, or store the full project path and append only
   `agent_sessions`. (Implementation detail; settle in the provisioning doc.)
3. **`me opencode init --scope` becomes project-only** — the `--scope` flag shipped
   on `me opencode init` (PR #115) is removed; `init` is project-scope only.
   `--scope` stays on `me <harness> install`.
4. **`read@share` default?** The meeting assumed members get `owner@home` +
   `read@share`; code exploration found only `owner@home` (share via invite
   `share_access`). Verify — it gates whether public transcripts are readable by
   all, and interacts with the default-group work.
5. **Provisioning specifics** live in `AGENT_PROVISIONING_DESIGN.md`: the agent's
   default grant breadth (act-as-human), the server changes (`X-Me-Agent`;
   agent-grants-without-owner), and the default-group / invites mechanism.

---

## Appendix — touch-points (for implementation scoping)
- Core: `packages/cli/credentials.ts` (`findProjectConfigDir`, layered read incl.
  the `.me/` `agent` id, `agent` mode in `resolveCredentials`, `resolveServer`/
  `resolveSpace`, `me space use` writing the project config), root `--agent` /
  `--config-dir` options in `packages/cli/index.ts`, `packages/cli/session.ts` /
  client transport (send `X-Me-Agent` in agent mode; suppress it when `ME_API_KEY`
  is an agent key).
- Server: new **`X-Me-Agent`** header (authenticate human, authorize as the named
  owned agent, clamped; ignored when the bearer is an agent key); allow setting an
  agent's own grants without space owner.
- Provisioning: **out of scope here** — separate design (creates/adds/grants the
  agent; records its id in `.me/config.yaml`; no key stored).
- Init: the shared wizard lives in the agent-agnostic layer (`packages/cli/agent/`);
  each `me <harness> init` runs it then wires that harness. `me opencode init`
  drops `--scope` (project-only) and defaults the capture tree to `~/projects/<repo>`.
- Integration (per harness, Tier 1 + Tier 2):
  - OpenCode: `commands/opencode.ts` (bake `--agent`, optional `--config-dir`),
    `opencode/plugin-template.ts` (add `shell.env` exporting `ME_AGENT`).
  - Claude: `commands/claude.ts` + `packages/claude-plugin` (`--agent` in MCP +
    hook commands; write `env.ME_AGENT` into `.claude/settings*.json`).
  - Codex: `me codex` install/init (`--agent` in `mcp_servers` args + hook
    command; `[shell_environment_policy] set` for `ME_AGENT`).
  - Gemini: `me gemini` install/init (`--agent` in `gemini mcp add` args + hook
    command; write `.gemini/.env` with `ME_AGENT`).
  - Note: Codex live-capture hooks + project config are newly available; the
    Codex/Gemini integrations otherwise mirror OpenCode (capture + MCP + recall
    command + skill + memory pointer).
- Docs: new `docs/cli/me-config.md` (the `.me/` model, `X-Me-Agent`, `me space use`
  behavior); updates to `me-opencode.md` / `me-codex.md` / `me-gemini.md` /
  `me-claude.md`, `mcp-integration.md`, getting-started.
