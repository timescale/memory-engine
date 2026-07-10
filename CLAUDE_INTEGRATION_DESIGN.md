# Claude Code integration — `me claude install` + `me project init`

Status: **implemented on `main`** — PR 1 (#132), PR 2 (#133), and PR 4 (#135)
are merged. PR 3 (secondary MCPs) is **parked — unscheduled indefinitely**
(the plan is written and ready if it's ever picked up); the follow-ups remain
unscheduled.
Reconciled with the meeting
notes below: **one** user-scoped plugin (`me claude install`) that reads a
project's `.me/config.yaml` with global fallback, plus a harness-agnostic
`me project init` that writes that config. **Capture is off by default** — the
hook ships inert; `me claude install` *asks* whether to turn it on (private by
default), and a project can share it or opt out via `.me/config`. **Rebased on
`main`:** the act-as-agent stack this relied on (`X-Me-As-Agent` + the `.me`
sentinel) is already merged — so PR 1 is now just capture gating + the install
rework (see *Proposed PRs*).

## Meeting notes (jul 2)

### Principles

- make install simple
- push down as much logic as possible to the config - so can share across harness
- not require project config to do useful stuff
- non-project things go into private dir
- projects are for when you want to customize for a particular project (potentially sharing)

### How claude would work

- one user-scoped install of the plugin
  - listens to .me/config but falls back to global
  - global config should by default (but these can be changed):
    - pin space/server
    - not use an agent
    - tree root would default to ~/projects/<slug>
  - project config would
    - pin space/server
    - pin tree root for project (through wizard)
    - determine an agent if needed (through wizard) - would also be written to settings.json env var
  - we can easily pin an agent for everything claude does through settings.json env vars at user/project scope.
- If we want "parallel access" to other spaces use an mcp server. But the automatic write paths import/hooks all work through the plugins
  - so you'd have a one-plugin many secondary mcp model for power users.

### Commands

- me claude install - installs the plugin
- me project init - initializes the project config

## The problem we're fixing

Today `me claude install` and `me claude init` both install the *same* plugin
but disagree on scope, and the capture hook fires **everywhere** the plugin is
enabled — always into the *shared* `share.projects.<slug>`:

- `me claude install` — `--scope` flag, defaults to **user** (global).
- `me claude init` — hardcodes **user** scope (`claude.ts:615`), even though
  every other init step (session backfill, git hook, CLAUDE.md pointer) is
  scoped to *this* repo.
- The hook has no notion of *whose* memory a session is: it captures into the
  **shared** `share.projects.<slug>`, so a global install quietly publishes every
  project you open into the team space.

Muddled mental model, plus a privacy default (everything shared) nobody chose.

## The model

Push the per-project choices into **config**, and keep the harness wiring to a
**single install**:

- **One user-scoped plugin** — `me claude install`, run once. It provides the
  memory tools + capture hooks in every project. At runtime it reads the
  project's `.me/config.yaml` (cwd walk-up) and **falls back to your global
  `~/.config/me` config** when there isn't one.
- **Useful with no project config** (principle: *don't require project config to
  do useful stuff*). On the global config alone the plugin gives you the memory
  **tools** in every project, running as **you** (no agent).
- **Capture is opt-in and off by default.** The capture **hook ships inert**;
  `me claude install` *asks* whether to turn it on. If you say yes, it flips the
  hook on via your global config and captures into your **private** home at
  **`~/projects/<slug>`** (`<slug>` from the repo) — so any non-project capture
  lands in your **private** dir, never a shared space.
- **`me project init` customizes a project** (principle: *projects are for when
  you want to customize, potentially sharing*). It is **harness-agnostic** — it
  writes `.me/config.yaml`, which every harness's plugin reads. A project config
  **must pin the space + server** (so the project is deterministic — everyone
  captures to the *same* place, not their own active space); via a wizard it also
  sets the project **tree root** (e.g. public `/share/projects/<slug>` to share
  with the team, vs the private default) and **sets up a dedicated agent** — the
  wizard always configures one (it offers no run-as-your-own-user option), though
  the `agent` field itself stays **optional** in the config. The agent is also
  written to a `settings.json` env var so it applies to everything Claude does.

| Command | Job | Scope |
|---|---|---|
| **`me claude install`** | Install the one plugin (tools + capture hooks). | user (global), harness-specific |
| **`me project init`** | Write this project's `.me/config.yaml` (space/server, tree root, agent). | project (committed), harness-agnostic |

Analogy: `install` = "add the tool for me" (once, like `npm i -g`);
`project init` = "configure *this* project" (like `git init` writing repo config
the tools then read).

## `me claude install` — the one plugin

```bash
me claude install            # user scope, once; no --scope decision
```

- Installs the plugin at **user** scope: the memory MCP tools always on, plus the
  capture hooks — **which ship inert** (see below).
- **Persists global defaults** into your `~/.config/me` config: your **space** +
  **server** (the currently resolved/active ones), plus the **capture** setting
  (from the prompt below). The private **`~/projects` tree root** and **no agent**
  are **code defaults, not persisted keys** — the hook just falls back to them, so
  install writes no `tree_root`/`agent` global field (a global override can be added
  later). Server/space are changeable via the usual `me` commands, and any project
  can override per-field in `.me/config.yaml`.
- **Asks whether to turn on capture.** Default is **no capture**. If you say yes,
  it:
  1. **runs `me import claude`** once at the end — a one-time backfill of your
     existing Claude sessions, and
  2. **turns the hook on via the global config**, so new sessions are captured
     going forward (into `~/projects/<slug>`, private, per the defaults above).

  Say no and you get the tools only; the hook stays inert.
- At runtime it resolves space / server / tree root / agent from the project
  `.me/config.yaml` if present, else these global defaults — and captures **only
  when capture is enabled** (globally here, or per-project via `.me/config`).

There is only ever this one plugin install. Project-level sharing is done through
committed **config** (below), not a second (project-scope) plugin.

## `me project init` — configure a project

```bash
cd my-repo
me project init              # writes .me/config.yaml (harness-agnostic)
```

Runs an interactive wizard (see `CLAUDE_INIT_WIZARD.md`) and writes
`.me/config.yaml` at the repo root:

```yaml
# .me/config.yaml  (committed)
server: https://api.memory.build   # where memories go
space: acme-eng                    # the X-Me-Space
tree: /share/projects/my-repo      # public → shared; default is private ~/projects/<slug>
agent: my-repo-agent               # optional; the wizard always sets one
capture: true                      # collect this project's agent sessions (default on)
```

- **Space + server are required** — a committed project config must be
  self-contained, so `me project init` always writes both (defaulting to your
  current resolved space/server). The tree root defaults if unset.
- **Session capture** — a toggle (default on) writes a **`capture`** flag; the
  already-installed plugin's hooks honor it, so a project can **opt out** of
  collecting its agent sessions (e.g. a sensitive repo) while still getting the
  tools + backfill. Absent = on, matching the global default.
- **Visibility** — *public* nests the project tree root under the shared `share`
  (team-wide); *private* under your home `~` (the default).
- **Agent** — the `agent` field is **optional** in the config, but the
  `me project init` wizard **always sets one up** (it offers no run-as-your-own-user
  option; that's a wizard choice, not a schema requirement — and the global,
  no-project case still runs as you). The wizard offers: a new agent scoped to the
  **whole space**, a new agent scoped to **this project only**, or an **existing**
  agent. Its name is written to `.me/config.yaml` (harness-agnostic — the plugin's
  hooks + MCP read it) and, for Claude, *also* to the project
  **`.claude/settings.json`** `"env": { "ME_AS_AGENT": "<agent name>" }` (committed)
  so *ad-hoc* `me` calls in Claude's Bash tool act as the agent too. It's the
  **literal agent name**, not the `.me` sentinel: the Bash tool runs from an
  arbitrary cwd, where a `.me` walk-up wouldn't find the project config.
- One file drives **all** integrations (the plugin's hooks + MCP, the `me` CLI,
  `me import git`) across **every** harness — so there's nothing Claude-specific
  to commit.

No plugin is installed here: the already-installed user-scoped plugin picks up
this config as soon as you're in the repo. Teammates who have run
`me claude install` get the project's behavior just by cloning the committed
`.me/config.yaml` — no per-repo install.

### Naming: keep the field `tree`; the concept is "project tree root"

Two "roots", kept distinct:

- **filesystem project root** — the git root / cwd, used to decide *where* to
  write `.me/` and to derive the `<slug>`. (`InitStepContext.projectRoot`.)
- **project tree root** — the ltree path memories nest under: the
  `.me/config.yaml` **`tree`** field (`project-config.ts:67`) / the hook's
  `projectTree` (`capture.ts:58`). Memories land at `<tree>/agent_sessions` (no
  slug appended when set explicitly).

The YAML field stays `tree`; this doc names the *concept* "project tree root".

## Whether — and where — captures go

**First, is capture on?** The hook is **inert unless capture is enabled**,
resolved highest-first:

1. the project `.me/config.yaml` **`capture`** (from `me project init`), else
2. the **global** capture setting — **off** unless you opted in at
   `me claude install`.

**Then, where does it nest?** When on, captures nest under a **project tree
root**, resolved highest-first in `resolveHookConfigFromEnv`:

1. the project `.me/config.yaml` **`tree`** — e.g. public `/share/projects/<slug>`;
2. the global default **`~/projects/<slug>`** — private, per-repo `<slug>` from
   the session `cwd`.

So capture is **off by default**, **private** once enabled, and **shared only when
a project opts in** — versus today's always-on default into the shared
`share.projects.<slug>` (see *What changes*).

> The one-time backfill `me import claude` (which `install` runs for you when you
> opt in) is an explicit, user-invoked sweep and can choose its own tree.

## User journeys

### 1. Solo dev

```bash
me claude install                  # once — asks "capture your sessions?"; say yes
# → backfills existing sessions (me import claude) + turns the hook on
# now: work in any repo → captured privately to ~/projects/<slug>
cd project-a && me project init    # optional: customize (make it public, pin an agent, …)
```

If you opt into capture at install, sessions land in your private home by default;
`me project init` is only for when you want to change that per project — share it,
scope an agent, pin a space. (Say no at install and you just get the tools; the
hook stays inert.)

### 2. Team repo

```bash
# One person, once:
cd team-repo && me project init    # choose public → tree /share/projects/team-repo
git add .me/config.yaml && git commit
```

A teammate who has run `me claude install` clones and — logged into `me` —
captures into the team's shared space automatically:

- **server / space / tree** come from the committed **`.me/config.yaml`**.
- **capture** is enabled by the committed config (`capture` + a shared `tree`), so
  the repo captures **even if the teammate never opted into global capture** at
  install — the project setting wins.
- **credentials** fall back to *each* teammate's own `me login` session (no shared
  secret in git).
- a **scoped agent** (if configured) applies via `.me/config.yaml` + the
  `settings.json` env var.

**No per-repo install** — the single user-scoped plugin reads the committed
config. "Clone the repo → your Claude sessions capture into the team's space"
falls out of one committed file.

### 3. Power user — one plugin + multiple secondary MCPs

A dev whose project captures to the team space, but who also wants to *search*
two other spaces from a session — a company-wide `org-knowledge` space and a
personal `research` space:

```bash
me claude install                       # the one plugin: capture + tools for the resolved space
cd team-repo && me project init         # this project captures into the team space

# add read/query access to other spaces as secondary MCP servers (tools only):
me claude mcp add org-knowledge         # secondary server "me-org-knowledge"
me claude mcp add research              # secondary server "me-research"
me claude mcp list                      # name → space/server for every me-backed registration
me claude mcp remove research           # gone (drives `claude mcp remove`)
```

Result:

- **Capture / writes** always flow through the **plugin** to the *project's*
  space (team). The automatic write paths (import + hooks) stay with the plugin;
  secondary MCPs are **tools-only** and never capture.
- In a session the model sees the plugin's memory tools (project space) **plus a
  distinctly named toolset per secondary MCP** (e.g. `mcp__me-org-knowledge__*`,
  `mcp__me-research__*`), so it can search each space explicitly and can't confuse
  which space it's reading.
- Each secondary MCP is pinned to its own space (and may carry its own
  agent/credentials); none of them change where captures land.

This is the **one-plugin, many-secondary-MCP** model: **one write path** (the
plugin → the project's space) and **many read/query surfaces** (secondary MCPs →
other spaces) — rather than juggling multiple plugins. Each secondary gets a
distinct MCP name — `me-<space>` by default, `--name <n>` to override — hence a
distinct tool namespace, so they don't collide with each other or the plugin.
(Command shape resolved in open question 3 / PR 3.)

## What changes vs today

- **Capture is off by default and opt-in at install.** Today a global install
  captures *every* session into the shared `share.projects.<slug>`. Now the hook
  ships **inert**; `me claude install` **asks**, and only if you opt in does it
  backfill (`me import claude`) and turn the hook on — into your **private**
  `~/projects/<slug>`. Sharing is a further explicit `me project init` (public)
  choice. **Migration note:** existing always-on installs become opt-in + private
  until re-enabled and/or shared.
- **`me claude install` persists global defaults.** It drops the `--scope` flag
  (there's just the one user-scoped plugin) and — unlike today's *pin-nothing*
  install — writes **server + space** (and the capture setting) into `~/.config/me`.
  The private `~/projects` tree root and "no agent" are **code defaults, not
  persisted keys**.
- **`me claude init` → `me project init`**, now **harness-agnostic**, and it **no
  longer installs a plugin** — it only writes `.me/config.yaml`. There is a single
  user-scoped plugin (`me claude install`).
- **Project behavior is config, not scope.** Space / server / tree / agent live in
  `.me/config.yaml` (committed, drives every harness); the plugin reads it with
  global fallback. The per-scope-plugin idea — and its scope-blind "already
  installed" probe — is gone.
- **A project config requires space + server.** Today all `.me/config.yaml` fields
  are optional (a `.me` may pin only a `tree`); a project written by
  `me project init` must pin space + server so it's self-contained for the team.
- **A project sets up a dedicated agent.** The `.me/config` `agent` field is now
  **wired on `main`**: it's the value source for the `--as-agent .me` /
  `ME_AS_AGENT=.me` sentinel that sends `X-Me-As-Agent`, honored by `me mcp`, the
  capture hook, and the CLI. The remaining work is the **writer** — `me project
  init` configures an agent (new whole-space, new this-project, or existing) and
  writes it to `.me/config.yaml` **+** Claude's `.claude/settings.json`
  `ME_AS_AGENT=<agent name>` (the literal name, not the `.me` sentinel — the Bash
  tool runs from an arbitrary cwd; PR 2). The field stays optional; activation is
  always explicit, and the global no-project case still runs as you.
- **Parallel access** to other spaces is a secondary MCP server, not another
  plugin.

## Proposed PRs

Design-only today; this is how the implementation would split. Docs ship **with
each PR** (no standalone docs PR) — each lists its doc changes. Dependencies in
parentheses.

> **Already on `main` (this branch is rebased on it): the act-as-agent stack.**
> `X-Me-As-Agent` (`AS_AGENT_HEADER` in `@memory.build/protocol/headers`), the
> server middleware (`packages/server/middleware/act-as-agent.ts` +
> `authenticate-space.ts` / `authenticate-user.ts`: resolve an *owned* agent by
> id/case-insensitive name, reject ambiguous, clamp to the agent's own
> authority), the client (`packages/client/as-agent.ts`), and the CLI surface —
> the `--as-agent <idOrName>` global flag + `ME_AS_AGENT` env, resolved by
> `resolveAsAgent()` / `isAsAgentRequested()` in `credentials.ts`, including the
> **`.me` sentinel** that sources the id from `.me/config.yaml`'s `agent`. It is
> already plumbed through `me mcp`, `me serve`, the opencode + **Claude capture
> hook** (`config.asAgent`). So the design's original *"wire up the `agent`
> field"* commit is **done — but via the explicit sentinel** (John's model), not
> the automatic resolution the comparison section below still argues for. A bare
> `.me` `agent` never activates the mode; activation is always explicit. **What
> remains for the agent is provisioning + writing it into config/env — that's
> PR 2's wizard** (create + grant the agent, write `agent:` to `.me/config.yaml`
> and `ME_AS_AGENT=<agent name>` to `.claude/settings.json` — the literal name,
> not the `.me` sentinel, since Claude's Bash tool runs from an arbitrary cwd).
> The capture hook then acts as the agent because that env is in scope — no
> automatic resolution needed.

1. **Capture gating + `me claude install` rework** — one PR, three commits,
   ordered `1 → 2 → 3` (each builds on the previous). (The former "wire up the
   `agent` field" commit is dropped — it's on `main`; see the note above.)

   - *Commit 1 — Capture gating (the `capture` key + inert, private hook).* Today
     the hook captures **always**, into `share.projects.<slug>` (`DEFAULT_TREE_ROOT`,
     `packages/cli/importers/index.ts:104`). Make it opt-in and private:
     - Add a **`capture`** key to **both** configs: `capture: z.boolean().optional()`
       on `projectConfigSchema` (`project-config.ts`, keep `.strict()`), and a
       machine-wide `capture?: boolean` on the global `ConfigFile`
       (`credentials.ts`) with a `setCaptureEnabled()` writer (mirrors
       `setActiveSpace`) surfaced on `ResolvedCredentials` (e.g. `captureEnabled`).
     - **Gate `resolveHookConfigFromEnv`** (`packages/cli/claude/capture.ts`):
       resolve capture-on highest-first — project `.me` `capture` → global setting
       → **off**. When off the hook exits 0 **silently** — a *distinct* path from
       the existing `null`-config branch, which logs "no credentials"
       (`claude.ts:504`) and would be misleading for a deliberate opt-out (gate
       before `resolveHookConfigFromEnv`, or return a discriminated "disabled"
       result rather than reusing `null`).
     - **Private default tree root = `~/projects`.** Replace the hook's hardcoded
       `share.projects` fallback with a private **`~/projects`** default (slug
       appended → `~/projects/<slug>`) — a new shared constant (e.g.
       `DEFAULT_PRIVATE_TREE_ROOT`) that **commit 2 reuses** for `me import claude`
       **and `me import git`** (concern 7 — unify privacy defaults). Keep the raw
       `DEFAULT_TREE_ROOT = "share.projects"` only for explicit opt-ins / headless
       plugin pins, not as any command's default.
       No client-side `~` resolution is needed: the composed `tree` (`sessionTree`,
       `importers/index.ts:76`) is normalized server-side (`normalizeTreePath`,
       `server/rpc/memory/support.ts:56`), which expands a leading `~` to the
       caller's `home.<id>` and splits on `/`/`.`. Contract cleanup: drop the
       "ltree-safe" restriction on `treeRoot`'s `WriteOptions` doc
       (`importers/index.ts:159`) so it accepts the lenient `~`/`/` form like
       `projectTree` (`~` must be the first segment — it is).
     - Tests: `capture.test.ts` — hook off by default; project vs global `capture`
       precedence; private `~/projects` default; project `tree` still wins.

   - *Commit 2 — `me import claude` reads the tree from config.* Today
     `buildOptions` (`import.ts:120`) hardcodes `treeRoot` and **never sets
     `projectTree`**, so `me import claude` ignores `.me/config.yaml` `tree` while
     the hook honors it — a backfill and live capture can land in different roots.
     Fix it to resolve like the hook, and like `me import git` already does
     (`import-git.ts:194`: `opts.projectTree ?? creds.projectTree ?? …`):
     - Read the `.me` `tree` from **`creds.projectTree`** (already surfaced,
       `credentials.ts:611`) and set `write.projectTree`; default `treeRoot` to the
       shared private **`~/projects`** (the commit-1 constant) instead of
       `share.projects`. (`buildOptions` gains a `projectTree`/`creds` input,
       resolved in `runAgentImport` where `creds` already exists.)
     - Precedence mirrors the hook: explicit `--tree-root` (parent+slug) > `.me`
       `tree` (`projectTree`, no slug) > private `~/projects` default (parent+slug).
       So the install-time backfill (commit 3) resolves **identically** to live
       capture, with no flags.
     - Applies to the shared agent-session `buildOptions` (claude/codex/opencode/…),
       so all session backfills go private-by-default consistently. **`me import git`
       (separate path) also switches its default to private `~/projects`** (concern
       7), so commits and sessions share the same private-by-default root.
     - *Scope caveat (→ PR 4):* the CWD `.me` `tree` is one project's node (no
       slug) — correct for a **scoped** run (`--project <repo>`, which the
       init/backfill uses), but not a bare multi-project sweep (it would nest every
       project's sessions under one node). So PR 1 keeps bare sweeps on the
       `~/projects` + per-slug fallback; making a multi-project sweep honor each
       project's own `.me` `tree` is **PR 4** (per-session resolution).
     - Tests: `me import claude` picks up `.me` `tree` + the `~/projects` default;
       `--tree-root` overrides; a scoped `--project` run matches the hook's tree.

   - *Commit 3 — `me claude install` rework* (`packages/cli/commands/claude.ts`).
     One user-scoped plugin:
     - **Drop `--scope`.** `createClaudeInstallCommand` / `runClaudePluginInstall`
       hardcode `user` (the `plugin-install` init step already passes
       `scope: "user"`); remove `parseClaudeScope` / the `-s, --scope` option.
     - **Pin global defaults** into `~/.config/me` on install. Only **server +
       space** are *persisted* (`setDefaultServer` / `setActiveSpace`), plus the
       `capture` flag from the prompt below. The **`~/projects` tree root** and
       **"no agent"** are **code defaults, not new `ConfigFile` keys**: the hook
       already falls back to `~/projects` (commit 1) and to no `ME_AS_AGENT`, so
       PR 1 adds no `tree_root`/`agent` global fields (a global override can come
       later if wanted). (`buildPluginConfig` still pins nothing into
       `CLAUDE_PLUGIN_OPTION_*` for a session install — the plugin tracks live
       config; the headless `--api-key` path is unchanged.)
     - **Capture prompt** (clack `confirm`, default **no**). On **yes**:
       `setCaptureEnabled(true)` + run a **machine-wide `me import claude`** sweep
       once (`install` is global — *not* repo-scoped), backfilling all past sessions
       per-slug under the private **`~/projects/<slug>`** default (the same root live
       capture uses for a project with no `.me` `tree`; honoring each project's own
       `.me` `tree` in a bulk sweep is PR 4). On **no**: leave capture off — the hook
       stays inert (per commit 1).

   **Docs:** `docs/cli/me-claude.md` (install rework — one plugin, no `--scope`,
   capture prompt, pinned defaults); `docs/cli/me-import.md` (commit 2 — `me import
   claude` honors the `.me` `tree`, private `~/projects` default); `docs/project-config.md`
   (new `capture` field, capture-off-by-default + private tree-root resolution; note
   `agent` is honored via the shipped `.me` sentinel); `docs/getting-started.md`
   (install now prompts for capture); `packages/claude-plugin/README.md` (hook inert
   by default). *(Deps: none — act-as-agent already on `main`.)*
2. **`me project init` — the interactive wizard** (a rework of today's
   `me claude init`, now harness-agnostic). Full UX in **`CLAUDE_INIT_WIZARD.md`**;
   this is the implementation split — three commits. All phases reuse the existing
   CLI clients (`buildUserClient` / `buildMemoryClient`, `util.ts:125`/`:140`) and
   the `@clack/prompts` idioms already used across `commands/`.

   - *Commit 1 — Config + settings writers (plumbing).*
     - **General `.me/config.yaml` writer.** `writeProjectSpace` (`project-config.ts:182`)
       only *edits* a file that already defines `space` — it is **not** create-if-absent.
       Add `writeProjectConfig(projectRoot, { server?, space?, tree?, agent?, capture? })`:
       `mkdir` the `.me/` dir, load-or-init the doc via `parseDocument` (preserving
       comments when the file already exists, per `:198`), `doc.set` each provided
       key, **validate against `projectConfigSchema`**, and null the memo (`cached`,
       `:202`). The schema / dir constants / `cached` are module-private, so this
       lives *in* `project-config.ts`. (Needs PR 1's `capture` schema field — a
       strict schema otherwise rejects the round-trip.)
     - **`.claude/settings.json` env merge.** No helper exists (searched cli +
       claude-plugin). Add one: read-or-init the JSON, set `env.ME_AS_AGENT` to the
       **literal agent name/id** (the same value written to `.me/config.yaml`
       `agent:`), and write back preserving other keys. Plain `JSON.parse`/`stringify`
       (not YAML; no comments to keep); `.local` override is Claude's own
       `settings.local.json`. **Not the `.me` sentinel here:** Claude Code injects
       this env into its **Bash tool**, which runs `me` from an arbitrary cwd
       (`/tmp`, `$HOME`, …) where a `.me` walk-up won't find the project config, so
       the sentinel would fail to resolve — the literal name works from any cwd. The
       name is therefore duplicated across the two files, written together by the
       wizard (the `.me/config.yaml` `agent:` still drives the sentinel for `me`
       run *inside* the project; settings.json covers the out-of-tree Bash calls).
     - **Fix the CLAUDE.md pointer to honor the chosen tree.** `writeMemoryPointer` /
       `resolveMemoryPointer` (`agent/memory-pointer.ts:75`) hardcode the pointer's
       tree as `share.projects.<slug>` from `process.cwd()`, **ignoring** a
       custom/private `.me` `tree` — so a private or custom project gets a pointer
       aimed at the wrong node. Resolve the pointer tree from the project config
       (`creds.projectTree` / the written `tree`), falling back to
       `share.projects.<slug>` only when unset.
     - Tests: writer creates `.me/config.yaml` (+ dir) and round-trips the schema;
       preserves comments on an existing file; settings merge adds `env.ME_AS_AGENT`
       without clobbering; pointer uses the config tree.

   - *Commit 2 — The wizard: preflight + prompts + provisioning.* A new `me project`
     group (`createProjectCommand()`), registered in `index.ts` by the other
     integrations (`:104`).
     - **Preflight** (`CLAUDE_INIT_WIZARD.md` §preflight): if `!creds.loggedIn` →
       `clack.confirm` → run `me login` (declining **stops** — a session is needed
       to list spaces / create agents); then the plugin — reuse
       `pluginInstallAvailable()` (`claude.ts:564`): if `available` and `claude` is
       on PATH, `clack.confirm` → `runClaudePluginInstall({ scope: "user" })`
       (declining **continues with a warning**).
     - **0. Space** — `user.space.list()` → `clack.select` (default =
       `creds.activeSpace`); a "＋ Create new" option → `clack.text(name)` →
       `user.space.create({ name })`. Pin **server + space** together (a space lives
       on one server).
     - **1. Location** — derive the slug once via `new SlugRegistry().resolve(cwd)`
       (`slug.ts:197` → `{ slug, gitRoot }`); `clack.select` public
       `share.projects.<slug>` (default) / private `~/projects.<slug>` / custom
       (`clack.text`). → the `tree`.
     - **2. Agent** — the wizard always sets one (no run-as-you option). `clack.select`:
       new whole-space / new this-project / existing (last hidden when the user has
       no agents). Provisioning is the four-call sequence the CLI already splits
       across commands: `user.agent.create({ name })` →
       `memory.principal.add({ principalId })` →
       `memory.grant.set({ principalId, treePath, access })` — **whole-space =
       `treePath:""`**, **this-project = the step-1 tree**, at `access: 2` (**write**
       — a coding agent reads/writes memories but shouldn't manage access). Still
       clamped server-side to `least(agent, owner)` via the own-agent short-circuit
       + `agent_tree_access`, and the clamp is **inherited per-path**, so a root
       (whole-space) grant gives the agent exactly what the caller can reach — no
       over-grant. Existing agent → write its name, grant nothing. Name prefill `<slug>-agent`, bumped to a free variant
       against `user.agent.list()`; step-2b access hint via
       `memory.grant.list({ principalId: agentId })`.
     - **Write** `.me/config.yaml` (server, space, tree, agent) + `.claude/settings.json`
       (`ME_AS_AGENT=<agent name>` — the literal name, not the sentinel; see
       commit 1) via the commit-1 writers, then invalidate creds so later steps see
       the pin.
     - Tests: prompt branches (existing vs new space/agent); provisioning call
       sequence; whole-space vs this-project grant path; config + settings written.

   - *Commit 3 — Setup checklist + retire `me claude init`.* The final phase
     (`CLAUDE_INIT_WIZARD.md` §3) is the grouped multiselect — reuse the
     `InitStep` / picker machinery in `agent/init.ts`.
     - Move the harness steps out of `commands/claude.ts` `INIT_STEPS` into the
       project command: `transcript-import`, `git-import`, `git-hook`, `claude-md`
       — **drop `plugin-install`** (now preflight) and **add a `capture-enable`
       step** (kind `ongoing`) that writes `capture: true` (selected) / `false`
       (unselected — explicit, so the committed config is deterministic for the
       team) via the commit-1 writer.
     - `transcript-import`'s backfill now **inherits the just-written `.me` tree**
       automatically (PR 1 commit 2 made `me import claude` read config) — no
       `--tree-root` needed; that's why config is written (commit 2) before the
       checklist runs.
     - The picker+run loop currently lives inside `buildInitCommand`'s action
       (`init.ts:207-241`); either lift it into a small shared `runInitSteps(steps,
       ctx)` so the wizard can run the checklist after its custom prompt phase, or
       drive `buildInitCommand` via a `resolveContext` that performs the prompt
       phase. Retire `me claude init` (remove, or a thin deprecated alias for one
       release) and update `MemoryPointerSpec.managedBy` `"me claude init"` →
       `"me project init"` (`claude.ts:541`).
     - Tests: `capture-enable` writes the flag both ways; the checklist runs only
       the selected steps; backfill lands under the config tree.

   **Docs:** new `docs/cli/me-project.md` (the wizard flow, mirroring
   `CLAUDE_INIT_WIZARD.md`); `docs/project-config.md` (the wizard writes
   server/space/tree/agent/capture + the `.claude/settings.json` `ME_AS_AGENT=<agent
   name>` env, with the `settings.local.json` override); repoint every `me claude init`
   reference to `me project init`. *(Deps: PR 1 — needs the `capture` schema field
   (commit 1) and `me import claude` reading config (commit 2).)*
3. **Secondary MCPs** — `me claude mcp add <space> [--name <n>]` (+ `remove`,
   `list`) for tools-only access to other spaces (distinct MCP + tool
   namespace). *(Status: **parked — unscheduled indefinitely.** The plan below
   is complete and ready if this is ever picked up; nothing else depends on
   it.)* Three commits. The enabling facts: the server name is what
   namespaces tools in Claude (`mcp__<name>__me_memory_*` — no MCP-server-side
   change needed), the name is currently **hardcoded `"me"`** at every
   registration site (the `MCP_TOOLS` registry `addCmd`/`removeCmd`,
   OpenCode's `buildOpenCodeConfig` `mcp.me` key) — so a second `--mcp-only`
   install today *overwrites* the primary instead of adding a sibling — and
   `me mcp --space <slug>` already works in any space the session's user is a
   member of (api-key path bakes `--api-key` + a pinned `--space`, same as
   today).

   Secondaries are a **dedicated command group**, not flags on `install`
   (open q3): registering another query surface is an add/remove-many-times
   operation, not an install, and the dedicated shape removes the guard rails
   the flag form would need — `<space>` is positional/required by
   construction, and `--name` can safely default to **`me-<space>`** (a new
   command has no existing `--mcp-only --space` re-pin semantics to break).
   `--mcp-only` on `install` survives **only** in its original role: the
   no-plugin primary install (name `me`), unchanged.

   - *Commit 1 — thread a server `name` through the MCP install layer.*
     `McpInstallOpts` gains `name` (default `"me"`); the registry
     `addCmd`/`removeCmd` take it (`claude|gemini mcp add --scope <s> <name>`,
     `codex mcp add <name>`), `buildOpenCodeConfig` keys `mcp[<name>]`;
     `installMcpServer` / `runAgentMcpInstall` (`AgentInstallOptions`) pass it
     through. Validate the name (`/^[A-Za-z0-9][A-Za-z0-9_-]*$/` — it becomes
     the tool prefix). The remove-and-re-add collision path is already
     per-name. Tests: existing addCmd/removeCmd/buildOpenCodeConfig units
     parameterized by name; default `"me"` byte-identical to today.
   - *Commit 2 — the `me claude mcp` command group.* `add <space>
     [--name <n>]` (default name `me-<space>`; reuses `runAgentMcpInstall`
     with the commit-1 `name`; session creds by default, `--api-key` for a
     headless secondary; success output names the tool namespace — `tools
     appear as mcp__<name>__…`); `remove <space> [--name <n>]` (mirrors
     `add`'s name resolution, drives the registry `removeCmd`); `list` (reads
     the same user-scope registry `claude mcp add --scope user` writes —
     `~/.claude.json` `mcpServers`, verify the exact location at
     implementation time; filters to entries running `me mcp`, renders name →
     server/space, and notes that the plugin provides the primary `me` server
     separately — plugin-managed servers don't appear in that registry).
     Reserved: `add` refuses `--name me` (that's the primary; use `install
     --mcp-only`). Claude-only in this PR: the machinery is shared, so
     `me gemini|codex|opencode mcp add/remove` is a mechanical follow-up.
     Tests: command wiring (name defaulting, reserved name, add/remove
     symmetry), `list` registry parsing.
   - *Commit 3 — docs.* `docs/mcp-integration.md` (the one-plugin,
     many-secondary model + the power-user journey); `docs/cli/me-claude.md`
     (the `me claude mcp add/remove/list` group; `--mcp-only` = no-plugin
     primary only).

   Decisions: **`--name` defaults to `me-<space>`** on the dedicated command
   (safe there — no existing behavior to change); `install --mcp-only` keeps
   its exact current semantics and gains nothing. **Full toolset, not
   read-only** — "tools-only" contrasts with hooks/capture (secondaries never
   capture); write *authorization* is `tree_access`'s job server-side.
   Deferred follow-ups: extending the `mcp add/remove` group to
   gemini/codex/opencode; a `--read-only` toolset subset; per-secondary agent
   identity via a baked `--as-agent` (headless secondaries already carry
   identity via agent api keys); preflight space validation (today `--space`
   is baked verbatim and fails at runtime with a clear server error —
   unchanged).

   **Docs:** `docs/mcp-integration.md` + `docs/cli/me-claude.md` (the
   `me claude mcp` secondary-server group). *(Deps: 1 for the install command
   shape; otherwise standalone.)*
4. **Per-session / per-target `.me` resolution for imports.** *(**Done — merged
   as #135** (`mat/import-per-session-tree`), as **full per-project routing**:
   rather than a parallel resolution implementation, each session's project
   runs the REAL local stack — `discoverProjectConfig(session.cwd)` passed
   explicitly to `resolveCredentialsFor(project)`, which shares one core with
   ambient resolution (the `--server` flag reaches it via a preAction seed, so
   a repo-authored server can only enter as `project.server`, always
   whitelist-gated) — memoized per cwd, one client per project (no reuse: the
   client carries the `asAgent` identity, per-project under the `.me`
   sentinel). So a sweep honors each project's server/space/tree with the
   documented flag/env precedence and the server whitelist gate intact by
   construction; un-writable projects become skip tallies
   (`project_config_error` / `no_credentials_for_server` /
   `no_space_for_project`). `me import git <repo>` resolves the target repo's
   `.me` the same way, fatally. Post-review: sweeps **reject** an explicit
   `--config-dir`/`ME_CONFIG_DIR` — a single-project pin contradicts
   per-session routing; single-target commands keep honoring it — and the
   `--project`-gated run-level tree in `buildOptions` was removed as dead
   (the router subsumes it).)*
   Original framing: PR 1's commit 2
   resolves the `.me` `tree` once from the process CWD, so it only fits a
   single-project (`--project`-scoped) run **invoked from inside that project**.
   Two gaps remain, both the same root cause (`.me` discovered from
   `process.cwd()` rather than from the relevant project):
   - a bare `me import claude` sweep across many repos still uses the
     `~/projects` + per-slug fallback — resolve the `.me` per **session**:
     discover `.me` from each session's own cwd (walk-up, memoized per
     directory) and set that session's `tree`/`treeRoot` accordingly, so a bulk
     sweep honors each project's committed tree, **exactly mirroring the live
     hook** (which is already per-session). Touches the write loop (`runImport`
     / `sessionTree`, `importers/index.ts`) to resolve per session rather than
     once per run.
   - scoped runs invoked **from outside the target** — `me import <tool>
     --project <repo>` and `me import git <repo>` — resolve `.me` from the
     caller's cwd, not the target repo, so the target's committed tree is
     ignored (flagged in #132 review). Per-session resolution subsumes the
     `--project` case; `me import git <repo>` should discover `.me` from the
     target repo path (the hook's `setConfigDirOverride(project.dir)` pattern,
     which keeps the server whitelist gate intact). Until this PR the supported
     way to scope from outside was `me --config-dir <repo> import …` (session
     sweeps now reject an explicit config-dir; `me import git` still honors it).

   **Docs:** `docs/cli/me-import.md` (multi-project sweeps honor each project's
   `.me` `tree`; scoped runs honor the target's). *(Deps: 1 — builds on its
   commit 2.)*

Suggested order (1, 2, 4 shipped): **1 → 2**; **3** (parked) and **4** anytime after 1 (4 builds on 1's
commit 2).

### Follow-ups (not scheduled)

- **De-dup / move across trees.** The same sessions can land in two trees: the
  install-time private backfill (`~/projects/<slug>`) and a later `me project init`
  public backfill (`share/projects/<slug>`), or when a project is flipped
  private→public. Idempotency only protects *within* a tree. A follow-up should
  offer to **move** (not re-copy) sessions when the tree changes, and de-dup an
  existing private copy. (Acceptable for now — noted so it isn't lost.)
- **Make `me project init` truly harness-agnostic — and retire `me opencode
  init` into it.** It's **Claude-first for now** — commits 1–2 write
  `.claude/settings.json` and commit 3 moves Claude-specific steps
  (`transcript-import`, `claude-md`) into it. The ultimate plan is
  harness-agnostic: gate the Claude-specific writes/steps on the harness in
  scope (or run them per-installed-harness), so an OpenCode-only project
  doesn't get Claude files — and absorb `me opencode init` the way `me claude
  init` was absorbed (deprecated alias), folding in its OpenCode-specific
  surface: the session backfill, the AGENTS.md pointer, the `/memory-recall`
  command + skill assets, and the project/user **scope chooser** (which needs
  a harness-detection design — deliberately not rushed into PR 2). The
  harness-agnostic pieces already apply to OpenCode today via `.me/config.yaml`
  (space/tree/agent/capture — the shared `capture-enable` step is one
  implementation across both inits); only the asset installs remain
  harness-specific.
- **`$prev` thread links on `~` trees resolve per-reader (TNT-157 interaction).**
  The importers stamp `$prev` client-side from the raw tree string
  (`stampConversationLinks` → `memoryPath`), so with the private `~/projects`
  default the stored link is literally `/~/projects/…`. The row's `tree` column
  is expanded at **write** time with the *writer's* home, but the link is only
  expanded at **read** time with the *reader's* — fine while reader == writer
  (self-capture), wrong when they differ. The common broken case once PR 2's
  wizard makes agents standard: an `ME_AS_AGENT` capture lands rows in the
  agent's nested home (`home.<owner>.<agent>.projects.…`), while the owner's UI
  resolves the stored `$prev` to `home.<owner>.projects.…` — a 404, or worse
  the **wrong copy** when the same session exists in both homes (wizard
  backfill runs as the human, live capture as the agent). Pre-existing for
  `.me` `~` trees; PR 1's private default makes it the normal private-project
  configuration. Preferred fix is **server-side**: normalize reserved link keys
  (`$prev`) with the same caller-home expansion the payload `tree` already gets
  at write, so stored links are absolute — the client *can't* do it (in
  as-agent mode it holds only the agent's name, not its home path).
  Alternative: resolve links at read time against the row's own `tree` (links
  are session-local in practice), but that changes TNT-157's "links are
  canonical paths" contract.

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

1. **Global default tree root — resolved.** `~/projects/<slug>` (private) is the
   no-config default; the `~`-form `treeRoot` resolves via `normalizeTreePath`
   server-side, and `<slug>` derivation is already shared code (`SlugRegistry`:
   git `origin` repo name → git root dir name → `basename(cwd)`). PR 1 swaps the
   parent (`share.projects` → `~/projects`) **and** makes `me import claude`
   resolve its tree from config (commit 2), so backfilled + live sessions share a
   node with no flags. *Non-blocking follow-up (PR 4):* making a bare multi-project
   `me import claude` sweep resolve `.me` **per session** (from each session's cwd,
   exactly mirroring the hook) rather than once from the CWD.
2. **Keep or drop `--mcp-only`? — resolved (PR 3 plan): keep, narrowly.** It
   survives only in its original role — the **no-plugin primary** install
   (register the `me` server without hooks/slash-commands), semantics
   unchanged. It is *not* the secondary-MCP surface (see q3).
3. **Secondary-MCP UX — resolved (PR 3 plan): a dedicated command group,**
   `me claude mcp add <space> [--name <n>]` / `remove` / `list` — not flags on
   `install`. Registering another query surface is an add/remove-many-times
   operation, not an install, and the flag form needed guard rails (`--name`
   requires `--mcp-only`, non-default name requires `--space`) that the
   dedicated shape makes impossible by construction. `--name` defaults to
   **`me-<space>`** (safe on a new command — no existing re-pin behavior to
   change); `add` refuses `--name me` (the primary's name). Secondaries expose
   the **full toolset** — "tools-only" contrasts with hooks/capture, and write
   authorization belongs to `tree_access` server-side; a `--read-only` subset
   is a deferred follow-up, as is extending the group to
   gemini/codex/opencode (shared machinery makes it mechanical).
4. **Agent via env vs config — resolved on `main`.** `ME_AS_AGENT` (incl. the
   `.me` sentinel) is read by `resolveAsAgent()` and already reaches `me mcp` +
   the capture hook (`config.asAgent`), so `me project init` writing
   `ME_AS_AGENT=<agent name>` into `.claude/settings.json` (PR 2) is sufficient —
   no automatic `.me` `agent` resolution needed. (Settings.json uses the literal
   name, not the `.me` sentinel — Claude's Bash tool runs from an arbitrary cwd
   where a `.me` walk-up wouldn't resolve; see PR 2 commit 1.)
5. **PR 2 — `me claude init` disposition.** *(Agent grant level — **resolved**:
   `write` (2), not owner. A coding agent reads/writes memories but shouldn't manage
   access; the per-path clamp means a whole-space (`treePath:""`) write grant gives
   the agent exactly what the caller can reach. See PR 2 commit 2.)* Still open: is
   `me claude init` **removed** or kept as a deprecated alias for one release?
   Leaning a thin alias that prints a rename notice, dropped next release. Doesn't
   block PR 2.
6. **Team agent identity — unresolved (blocks the team-repo story).** Act-as-agent
   resolves `X-Me-As-Agent` only against the caller's **own** agents
   (`core.listAgents(caller)`, CLAUDE.md "Act as agent"). So a single committed
   `.me/config.yaml` `agent:` + committed `.claude/settings.json` `ME_AS_AGENT=<name>`
   works **only for the creator**: a teammate who clones hits 403 `INVALID_AGENT` on
   every `me` call carrying that header — the committed settings.json actively
   *breaks* their ad-hoc Bash `me` calls, not just "fails to apply." This
   contradicts the **Team-repo journey** above ("clone → it just works; a scoped
   agent applies via `.me/config.yaml` + the settings.json env"). Options: (a)
   **per-user agent** — each teammate runs `me project init`, which creates + grants
   *their own* agent (a same-named agent resolves per-caller) and writes `ME_AS_AGENT`
   into the *gitignored* `.claude/settings.local.json` rather than the committed
   file; contradicts "one person once, teammates just clone." (b) teammates simply
   **capture as themselves** (no committed agent). (c) a **shared / space-owned
   agent** multiple members may act as — no such capability today. Resolve before
   PR 2 wires the committed `agent:` / settings.json, and fix the Team-repo journey
   to match.

## Comparison to John's design (Claude only)

John's clean-slate proposal ("4 harnesses × 2 scopes") shares this doc's
install-once + configure-per-project spirit, but for Claude it differs on three
things: it **drops the marketplace plugin** and writes files directly
(`claude mcp add`, `~/.claude` vs `.claude/settings.json` hooks, skills,
commands); it installs a **project-scope** set of files that **act as an agent**
(`--as-agent .me` + `ME_AS_AGENT=.me`); and it keeps **capture always on as the
human** by default, deduping the two scopes with a `--scope user|project` hook
flag. This section records how the two relate once we strip out what's *not*
actually a design fork. (With this doc now on a single user-scoped plugin +
config, John's project-scope *file writes* are the main structural difference.)

### Agent identity is orthogonal — not a scope-linked feature

> **Status — what shipped on `main`:** we kept identity in `.me/config.yaml`
> (the point below) but went with John's **explicit `.me` sentinel**, *not* the
> automatic resolution argued for here — a bare `.me` `agent` never activates
> agent mode; the user opts in with `--as-agent .me` / `ME_AS_AGENT`. Read the
> "automatic, no explicit opt-in" framing below as the historical rationale for
> keeping `agent` in the committed config; John's opt-in caveat (the next
> blockquote) is exactly why the final choice stayed explicit.

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
  design identically (surface `agent` through the `.me` resolution layer). It is
  **not** a reason to pick one design over the other, and it does **not** belong
  on the install-vs-init axis. *(As shipped, `main` did exactly this but kept it
  explicit — the `agent` field is now the value source for the `.me` sentinel,
  `project-config.ts`, rather than resolved automatically.)*

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

1. **Delivery: marketplace plugin (this doc) vs direct file writes (John).** With
   a single user-scoped plugin, this doc no longer has a project-scope install to
   probe for — the old scope-blind `plugin list` blocker is gone either way. The
   remaining contrast: John's direct writes also ship a **skill + `/memory-recall`
   command** the plugin path doesn't, at the cost of a clean-slate rewrite that
   retires `packages/claude-plugin`. John's §6 argues the plugin's only real edge
   is marketplace discoverability, worth keeping later as a thin optional wrapper.
2. **Capture default: opt-in/off (this doc) vs always-on-as-the-human (John).**
   This doc ships the hook **inert** and has `me claude install` *ask* before
   turning it on (then private, `~/projects/<slug>`); John captures *every* session
   out of the box into your personal space as the human. So this axis is now both
   **on/off** (opt-in vs automatic) **and** destination (private vs personal
   space). This doc's opt-in gate could layer onto John's model too.
```