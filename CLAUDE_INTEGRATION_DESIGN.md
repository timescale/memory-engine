# Claude Code integration — `me claude install` + `me project init`

Status: **proposal / design** (not implemented). Reconciled with the meeting
notes below: **one** user-scoped plugin (`me claude install`) that reads a
project's `.me/config.yaml` with global fallback, plus a harness-agnostic
`me project init` that writes that config. Capture works out of the box,
**private by default**, and is shared only when a project opts in.

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
  do useful stuff*). On the global config alone the plugin uses your active
  space/server, runs as **you** (no agent), and captures into your **private**
  home at **`~/projects/<slug>`** (`<slug>` from the repo). Capture works out of
  the box — and non-project captures land in your **private** dir, not a shared
  space.
- **`me project init` customizes a project** (principle: *projects are for when
  you want to customize, potentially sharing*). It is **harness-agnostic** — it
  writes `.me/config.yaml`, which every harness's plugin reads. A project config
  **must pin the space + server** (so the project is deterministic — everyone
  captures to the *same* place, not their own active space); via a wizard it also
  sets the project **tree root** (e.g. public `/share/projects/<slug>` to share
  with the team, vs the private default) and optionally **determines an agent** to
  scope access — the agent is also written to a `settings.json` env var so it
  applies to everything Claude does.

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

- Installs the plugin at **user** scope: the memory MCP tools + capture hooks,
  available in every project.
- **Pins the global defaults** into your `~/.config/me` config: your **space** +
  **server** (the currently resolved/active ones), a global **tree root of
  `~/projects/`** (so captures land in `~/projects/<slug>`), and **no agent**
  (runs as you). **Each of these is independently changeable** — edit the global
  config (or the `me` commands that manage it) to move the machine-wide default,
  or override any of them per-project via `.me/config.yaml`.
- At runtime it resolves space / server / tree root / agent from the project
  `.me/config.yaml` if present, else these global defaults.
- With no project config, captures land in your **private** `~/projects/<slug>`
  under your own identity — nothing is shared until a project opts in.

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
```

- **Space + server are required** — a committed project config must be
  self-contained, so `me project init` always writes both (defaulting to your
  current resolved space/server). The tree root defaults if unset; the agent is
  optional.
- **Visibility** — *public* nests the project tree root under the shared `share`
  (team-wide); *private* under your home `~` (the default).
- **Agent** — if you scope access to an agent, its name is written to
  `.me/config.yaml` (harness-agnostic — the plugin's hooks + MCP read it from
  there). For Claude, it's *also* written to the project **`.claude/settings.json`**
  `"env": { "ME_AS_AGENT": … }` (committed) so *ad-hoc* `me` calls in Claude's
  Bash tool act as the agent too. (This second write is Claude-specific — the
  harness-agnostic `.me/config.yaml` covers the plugin's own paths.)
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

## Where captures go (tree-root resolution)

Captures nest under a **project tree root**, resolved highest-first in
`resolveHookConfigFromEnv`:

1. the project `.me/config.yaml` **`tree`** (written by `me project init`) — e.g.
   public `/share/projects/<slug>`;
2. the global default **`~/projects/<slug>`** — private, per-repo `<slug>` from
   the session `cwd`.

So live capture is **always on**, but **private by default** and **shared only
when a project opts in** — a change from today's default of the shared
`share.projects.<slug>` (see *What changes*).

> The manual backfill `me import claude` keeps its own default tree — an
> explicit, user-invoked sweep can choose where it lands.

## User journeys

### 1. Solo dev

```bash
me claude install                  # once
# work in any repo → captured privately to ~/projects/<slug>
cd project-a && me project init    # optional: customize (make it public, pin an agent, …)
```

Everything is captured to your private home by default; `me project init` is only
for when you want to change that — share it, scope an agent, pin a space.

### 2. Team repo

```bash
# One person, once:
cd team-repo && me project init    # choose public → tree /share/projects/team-repo
git add .me/config.yaml && git commit
```

A teammate who has run `me claude install` clones and — logged into `me` —
captures into the team's shared space automatically:

- **server / space / tree** come from the committed **`.me/config.yaml`**.
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
me claude install --mcp-only --space org-knowledge --name me-org-knowledge   # secondary
me claude install --mcp-only --space research      --name me-research        # secondary
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
other spaces) — rather than juggling multiple plugins. The **`--name`** flag gives
each secondary server a distinct MCP name (hence a distinct tool namespace), so
they don't collide with each other or the plugin. (Exact command shape is open
question 3.)

## What changes vs today

- **Capture default flips shared → private.** The default tree root moves from
  `share.projects.<slug>` to **`~/projects/<slug>`**, so an out-of-the-box install
  captures to your **private** home, not the team space. Sharing is an explicit
  `me project init` (public) choice. **Migration note:** installs that relied on
  the shared default start writing privately until the relevant projects run
  `me project init` with a public tree.
- **`me claude install` pins global defaults.** It drops the `--scope` flag
  (there's just the one user-scoped plugin) and — unlike today's *pin-nothing*
  install — writes machine-wide defaults into `~/.config/me`: space + server, tree
  root `~/projects/`, and no agent, each independently changeable.
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
- **Agent** is conveyed via `.me/config.yaml` **plus** a `settings.json` env var,
  at user or project scope.
- **Parallel access** to other spaces is a secondary MCP server, not another
  plugin.

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

1. **Global default tree root.** Confirm `~/projects/<slug>` (private) as the
   no-config default, and how `<slug>` is derived (git remote vs directory
   basename) — it must match the importers so live + backfilled sessions share a
   node.
2. **Keep or drop `--mcp-only`?** The plugin now *is* the write path; a pure-tools
   (no-capture) install may still be worth offering.
3. **Secondary-MCP UX.** A secondary server is `me claude install --mcp-only
   --space <other> --name <mcp-name>` — the `--name` gives it a distinct MCP + tool
   namespace so it doesn't collide with the plugin or other secondaries. Open: is
   `--name` required or defaulted (e.g. `me-<space>`), and is `--mcp-only` on
   `install` the right home for this vs a dedicated command?
4. **Agent via env vs config.** We write the agent to both `.me/config.yaml` and a
   `settings.json` env var; confirm the env var (`ME_AS_AGENT`) actually reaches
   the plugin's MCP server + hooks in a running session (see the note in the
   comparison section).

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

1. **Delivery: marketplace plugin (this doc) vs direct file writes (John).** With
   a single user-scoped plugin, this doc no longer has a project-scope install to
   probe for — the old scope-blind `plugin list` blocker is gone either way. The
   remaining contrast: John's direct writes also ship a **skill + `/memory-recall`
   command** the plugin path doesn't, at the cost of a clean-slate rewrite that
   retires `packages/claude-plugin`. John's §6 argues the plugin's only real edge
   is marketplace discoverability, worth keeping later as a thin optional wrapper.
2. **Capture default: private-by-default (this doc) vs as-the-human (John).** Both
   capture *every* session out of the box — the axis is the default *destination*,
   not on/off. This doc defaults to your **private** home (`~/projects/<slug>`),
   made shared via `me project init`; John captures into your personal space as the
   human. Largely converged (both always-on); the residual difference is the
   default privacy of the landing tree.
```