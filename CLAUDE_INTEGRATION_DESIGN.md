# Claude Code integration — `install` vs `init` (usage-focused design)

Status: **proposal / design** (not implemented). Captures the intended split
between `me claude install` and `me claude init`, and the rule that makes a
global plugin install safe by keeping capture **inert until a project opts in**.

## The problem we're fixing

Today `me claude install` and `me claude init` both install the *same* plugin
but disagree on scope, and the capture hook fires **everywhere** the plugin is
enabled:

- `me claude install` — `--scope` flag, defaults to **user** (global).
- `me claude init` — hardcodes **user** scope (`claude.ts:615`), even though
  every other init step (session backfill, git hook, CLAUDE.md pointer) is
  scoped to *this* repo.
- The hook has no "should I capture here?" gate: `resolveHookConfigFromEnv`
  defaults `treeRoot` to `share.projects` and captures **any** session into
  `<share.projects>.<slug>.agent_sessions`. So a single global install quietly
  captures every project you ever open.

The result is a muddled mental model ("which command, which scope, and why is it
capturing my unrelated side project?").

## The mental model we want

Two commands, two jobs, no scope flag to reason about:

| Command | Scope | What it's for |
|---|---|---|
| **`me claude install`** | **user** (global) | Give *me* the memory tools everywhere. Capture stays **off** unless I'm in a project that opted in. |
| **`me claude init`** | **project** (committed) | Set up **this repo** for memory — backfill, git hook, CLAUDE.md pointer, **and** turn on capture by writing a `.me/config.yaml`. Shared with the team via git. |

Analogy people already hold: `install` = "add the tool for me" (like `npm i
-g`); `init` = "initialize *this* project" (like `git init`) — and initializing
a project is what *activates* capture.

The key move: **`me claude install` behaves almost like `--mcp-only`** — tools
always available, hooks present but inert — **until you `cd` into a directory
with a `.me/config.yaml`** (i.e. a project someone ran `me claude init` in).
Capture is opt-in per project, not opt-out per machine.

## `me claude install` — global, capture-inert

```bash
me claude install            # always user scope; no --scope decision
```

- Installs the plugin at **user** scope: MCP memory tools + capture hooks, in
  every project.
- The hooks are **inert by default** — see [the capture-activation
  rule](#the-capture-activation-rule). With no project config in scope, `Stop` /
  `SessionEnd` resolve to "nothing to capture" and no-op.
- So in practice this is "the memory tools, everywhere" plus *latent* capture
  that only wakes up inside an initialized project.

This makes a global install **safe**: opening a random repo, a scratch dir, or
`$HOME` never starts capturing.

> `--mcp-only` becomes nearly redundant under this design (a full install is
> already capture-inert globally). Open question below: keep it as an explicit
> "never capture, even in init'd projects" guarantee, or drop it.

## `me claude init` — this project, capture-on

```bash
cd my-repo
me claude init               # always project scope; sets up + activates capture
```

Runs the existing init steps, with two changes:

1. **Plugin install moves to `--scope project`** (committed to
   `.claude/settings.json`) — so a teammate who clones the repo gets the plugin
   without running anything.
2. **A new step writes `.me/config.yaml`** at the repo root, pinning:

   ```yaml
   # .me/config.yaml  (committed)
   server: https://api.memory.build   # where memories go
   space: acme-eng                    # the X-Me-Space
   tree: /share/projects/my-repo      # the project tree root (see naming note)
   ```

   This is the file that **activates capture** (it provides the project tree root)
   *and* points every other `me` invocation in the repo (CLI, `me mcp`, `me
   import git`) at the same server/space/tree. One file drives all integrations.

The other steps (session backfill, git post-commit hook, CLAUDE.md pointer) are
unchanged. As today, each step is deselectable in the interactive picker, so the
plugin/`.me` write is opt-out within init.

### Naming: "project tree root" is the `.me/config` `tree`

There are two "roots" — keep them distinct:

- **filesystem project root** — the git root / cwd, used only to decide *where*
  to write `.me/` and to scope the install. (`InitStepContext.projectRoot`.)
- **project tree root** — the ltree path this project's memories nest
  under. This is the existing `.me/config.yaml` **`tree`** field
  (`project-config.ts:67`) and the capture hook's `projectTree`
  (`capture.ts:58`). Memories land at `<tree>/agent_sessions` (no slug appended).

When this doc says init "pins the project tree root," it means writing the
**`tree`** field. We reuse the existing field rather than adding a new
`projectTreeRoot` key — they'd be the same thing. (Open question: is `tree` the
right *name* to surface to users, or should the doc/UX call it "project tree
root"?)

## The capture-activation rule

**The hook captures only when a project tree root is resolvable; otherwise it
no-ops.** Concretely, in `resolveHookConfigFromEnv`:

- Today: `treeRoot` always defaults to `share.projects`, so capture always
  proceeds.
- Proposed: capture proceeds **iff** one of these is set —
  1. a **`.me/config.yaml` `tree`** discovered from the session `cwd`
     (`discoverProjectConfig(event.cwd)` — the `me claude init` case), **or**
  2. an explicit **plugin-pinned `tree_root`** (`CLAUDE_PLUGIN_OPTION_TREE_ROOT`
     — the headless/unattended install that deliberately opted into a fixed
     tree).

  With neither, `resolveHookConfigFromEnv` returns `null` and the hook exits 0
  without writing. No more implicit `share.projects` fallback for live capture.

This is what makes `install` (global) safe and `init` (per-project) the switch
that turns capture on.

> Scope note: this only gates **live capture** (the hook). The manual backfill
> `me import claude` keeps its `share.projects` default — an explicit,
> user-invoked sweep is allowed to choose a default tree.

## User journeys

### 1. Solo dev, personal memory

```bash
me claude install            # tools everywhere, capture off
cd project-a && me claude init   # capture on for project-a → its space/tree
cd project-b                 # no .me → capture stays off; tools still work
```

Only `project-a` captures. `project-b` and everything else get the tools but no
capture. No global noise.

### 2. Team repo

```bash
# One person, once:
cd team-repo && me claude init
git add .claude/settings.json .me/config.yaml CLAUDE.md && git commit
```

A teammate clones and — if they're logged into `me` — capture is already on:

- **plugin** comes from the committed **project-scope** install
  (`.claude/settings.json`).
- **server / space / tree** come from the committed **`.me/config.yaml`**.
- **credentials** fall back to *each* teammate's own `me login` session (no
  shared secret in git). A dedicated agent key stays optional via the plugin's
  `api_key` userConfig.

So "clone the repo → your Claude sessions capture into the team's space" falls
out of two committed files, no per-dev setup.

### 3. Both (global + a team repo)

`install` (user) + `init` (project) install the *same* plugin
(`memory-engine@memory-engine`). Claude Code dedups the bundled MCP server **by
name** (`plugin_memory-engine_me`), connecting once from the higher-precedence
scope (**project > user**). No double MCP server. userConfig also resolves
project-over-user, so inside the repo the repo's settings win — which is what we
want.

### 4. Headless / unattended agent

Unchanged from today: a pinned `tree_root` + `space` + `api_key` (via the plugin
userConfig or a headless install) satisfies rule (2) of the activation gate, so
capture works without a `.me/config.yaml`.

## What changes vs today

- `me claude init` installs at **project** scope (was user) and writes
  `.me/config.yaml` (new step).
- `me claude install` drops the `--scope` decision and is **always user** (was
  user-by-default-but-flaggable).
- The hook **no longer captures without a project tree root** (was: always captured
  into `share.projects`). **Migration note:** anyone who today relies on a plain
  global plugin install to capture everything loses that until they
  `me claude init` the projects they care about (or pin a headless `tree_root`).
- Project config (server/space/tree) is expressed in **`.me/config.yaml`**
  (committed, drives all integrations) rather than the plugin's per-scope
  userConfig. The plugin userConfig shrinks to mainly `api_key` (+ optional
  headless `tree_root`/`content_mode`).

## Interactions & safety

- **Trusted-server gate.** A `.me`-sourced `server` is only honored if it's in
  `DEFAULT_TRUSTED_SERVERS` (prod + dev) or whitelisted. So a committed
  `.me/config.yaml` pointing at prod/dev "just works" for teammates; a custom
  server requires each teammate to whitelist it (or `me login --server`). This
  is the existing guard against a hostile repo redirecting your global
  credentials — it applies here unchanged.
- **`.me/config.local.yaml`** (gitignored) still overrides the committed file
  per field — a dev who wants their *own* space/tree in a team repo sets it
  there without touching the committed config.

## Open questions

1. **Scope-blind "already installed" probe (blocker).** `me claude init`'s
   plugin step decides "done" via `claude plugin list --json`, whose entries are
   `{id, version, enabled}` with **no scope field** (per the test fixtures). If a
   user ran `me claude install` first (user scope), `init` sees the plugin
   present and **skips the project-scope install** — silently failing its main
   job. This design makes "installed at user, want it at project too" the
   *normal* path, so it must be solved. Likely fix: for the project step, detect
   by reading the **project's `.claude/settings.json`** directly rather than the
   scope-blind global list. (Needs confirmation of where
   `claude plugin install --scope project` actually writes.)
2. **Keep or drop `--mcp-only`?** A full install is already capture-inert
   globally, so `--mcp-only`'s remaining value is "guaranteed never capture, even
   in init'd projects." Worth it, or is the inert-by-default install enough?
3. **Surface the field as `tree` or `project tree root`?** We reuse `.me/config`'s
   existing `tree` field; the UX/docs may still want to *call* it "project tree root."
4. **Escape hatches.** Do we keep an undocumented `--scope` on both commands for
   power users (the plumbing already exists), or commit fully to the opinionated
   split?
5. **`init` when a global install already exists.** The project-scope install is
   partly redundant *for the initializing user* (their global plugin already
   works once `.me/config` exists), but it's the mechanism that onboards
   *teammates*. Keep it unconditionally — just make sure (1) doesn't cause it to
   be skipped.

## Comparison to John's design (Claude only)

John's clean-slate proposal ("4 harnesses × 2 scopes") covers the same
`install` = user / `init` = project split, but for Claude it differs on three
things: it **drops the marketplace plugin** and writes files directly
(`claude mcp add`, `~/.claude` vs `.claude/settings.json` hooks, skills,
commands); it makes **project scope act as an agent** (`--as-agent .me` +
`ME_AS_AGENT=.me`); and it keeps **user-scope capture always on**, deduping the
two scopes with a `--scope user|project` hook flag. This section records how the
two relate once we strip out what's *not* actually a design fork.

### Agent identity is orthogonal — not a scope-linked feature

John's design ties agent identity to project scope: `--as-agent .me` is baked
only into the project-scope commands, and user scope is forced to be the human.
**That coupling is an artifact of the mechanism, not something intrinsic.** If
the agent is simply an **`agent:` field in `.me/config.yaml`**, identity rides on
the *project directory*, not on which scope installed the integration — and both
scopes pick it up for free:

- The **`.me/config`** is discovered by cwd walk-up and is already wired into
  `resolveServer` / `resolveSpace` / `resolveCredentials`, which **both `me mcp`
  and the capture hook inherit** (`me mcp` resolves `.me` from its launch cwd;
  the hook does `discoverProjectConfig(event.cwd)`). Surfacing `agent` through
  that same resolution means a user-scoped *and* a project-scoped install both
  act as the project's agent whenever they run inside a project that declares
  one — with **no per-scope `--as-agent` baking** and no `.me` sentinel plumbing.
- So "do we use an agent?" is an **independent overlay** that bolts onto *either*
  design identically (add `agent` to the `.me` resolution layer; the field
  already exists in the schema, parsed but unwired — `project-config.ts:72`).
  It is **not** a reason to pick one design over the other, and it does **not**
  belong on the install-vs-init axis.

This is strictly simpler than John's mechanism (which needs the strict `.me`
sentinel + per-scope flag baking) and gives full user/project parity for the
agent overlay.

> **Caveat (worth a deliberate look):** John made `--as-agent .me` *explicit and
> strict* partly for the `PROJECT_CONFIG_DESIGN.md` cooperative-scoping threat
> model. Making agent resolution *automatic* from a committed `.me/config` means
> a repo's `.me` names the agent you act as. This is almost certainly safe — the
> server validates `X-Me-As-Agent` against your PAT and `agent_tree_access`
> clamps to `least(agent, owner)`, so a hostile `.me` either names an agent you
> control or fails auth — but it trades away an opt-in John chose on purpose.

### What actually differs, once identity is factored out

Two axes, both about plumbing/defaults rather than capability:

1. **Delivery: marketplace plugin (this doc) vs direct file writes (John).**
   Direct writes dissolve [open question #1](#open-questions) by construction
   (scope is a file location, not a scope-blind `plugin list` lookup) and ship
   the **skill + `/memory-recall` command** this doc's plugin path doesn't. Cost:
   a clean-slate rewrite that retires `packages/claude-plugin`. John's §6 argues
   the plugin's only real edge is marketplace discoverability, worth keeping
   later as a thin optional wrapper.
2. **Capture default: inert-until-project-tree-root (this doc) vs always-on +
   `--scope` dedup (John).** John's user-scope hooks capture *every* session as
   the human by default; this doc's [capture-activation
   rule](#the-capture-activation-rule) captures nothing until a project opts in.
   These are separable: John's model would still work with this doc's inert gate
   bolted on, and that combination (direct writes + inert gate + agent overlay)
   is likely the best-of-both.
```