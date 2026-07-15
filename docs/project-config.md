# Project config (`.me/config.yaml`)

A project can pin its Memory Engine **server** and **space** — and, optionally, the
**tree** its integrations write to — in a `.me/config.yaml` file at the repo root.
Any `me` invocation inside the project (the CLI, the `me mcp` server, the
Claude/OpenCode capture hooks, `me import git`) then targets that server and space
automatically, with no per-command flags or environment variables.

This is what lets a project say "my memories live in space `X` on server `Y`,
under tree `Z`" once, and have every tool that touches the repo agree. For how
to choose that tree and its grants, see [Projects](projects.md).

The interactive [`me project init`](cli/me-project.md) wizard writes this file
for you — `server` + `space` (pinned together, so a committed config is
self-contained), the `tree`, a dedicated `agent`, and the `capture` flag.
Every harness surface (MCP, the Claude/OpenCode capture hooks, and a plain
`me` call from an agent's own shell) then resolves that `agent` automatically
— see [Agent-by-config](#agent-by-config-and-the-agent-field) below — so
there's no separate `.claude/settings.json` pin to keep in sync.

## The file

```yaml
# .me/config.yaml
server: https://api.memory.build   # pin the server
space: xjjg3kmq6vvb                 # pin the space (slug)
tree: /share/projects/acme          # optional: where integrations write (see below)
agent: acme-agent                   # optional: the project's agent (see below)
capture: true                       # optional: session capture on/off (see below)
import:                             # optional: the CI import run (see below)
  docs_include: ["docs/**"]
```

All fields are optional. A `.me` that sets only `tree` still inherits its
server/space from your global config. A **malformed** file — invalid YAML, or a
field that fails validation — is a hard error: `me` fails with a clear message
rather than silently ignoring the pins the project meant to apply. (The
best-effort capture hooks are the exception — they log and skip, so a typo never
breaks an agent session.)

> `agent:` names the project's default agent and is the value source for the
> `.me` sentinel: `--as-agent .me` / `ME_AS_AGENT=.me` resolves to it and sends
> `X-Me-As-Agent`. A harness surface (MCP, the capture hooks, a harness's own
> shell) activates this automatically — see
> [Agent-by-config](#agent-by-config-and-the-agent-field). A committed
> `agent: .user` is a fatal error (see below); it's valid only in
> `.me/config.local.yaml` or your global config.

## Trusted servers (credential safety)

A `.me/config.yaml` is **untrusted input** — you might `cd` into someone else's
repo. Because an api key (`ME_API_KEY`) and `ME_SESSION_TOKEN` are *global*
credentials (sent to whichever server is resolved), a malicious `.me` pinning
`server: https://attacker.example` could otherwise exfiltrate them.

So `me` only honors a **`.me` server pin** that is on a **trusted list**:

- Trusted by default: the prod server (`https://api.memory.build`) and the dev
  server.
- `me login --server <url>` adds that server (logging in is an explicit act of
  trust).
- You can hand-add more via `server_whitelist` in your global
  `~/.config/me/config.yaml`:
  ```yaml
  server_whitelist:
    - https://me.internal.example
  ```

A `.me` that pins an **untrusted** server is refused with a fatal error rather
than sending credentials to it. This gate applies **only** to a server chosen by
a project's `.me` — an explicit `--server` / `ME_SERVER` and your stored
`default_server` are your own choices and are never gated.

## Discovery

`me` finds the config by walking **up** from the current directory to the first
ancestor that contains a `.me/config.yaml` **or `.me/config.local.yaml`** — so it
works from any subdirectory of the project, just like `.git`, and a machine-local
project (only a `.local` file, no committed one) is discovered too.

To point at a specific project without being inside it, pass **`--config-dir <dir>`**
(the directory that contains `.me/`) or set **`ME_CONFIG_DIR`**. Either skips the
walk and uses that directory's `.me/` directly. (The one exception is the bulk
session sweep, `me import <tool>`: it routes every session by its *own* project's
config, so it rejects an explicit pin — see
[agent session imports](cli/agent-session-imports.md).)

There's also **`--project-dir <dir>`** / **`ME_PROJECT_DIR`** — an ANCHOR
rather than an exact location: `me` still walks up from it, it just replaces
`cwd` as the walk-up's starting point. This is what the harness-injected
shell contract sets on every command an agent's tool shell runs (see
[MCP Integration](mcp-integration.md)), so a `cd /tmp && me …` from an
agent's shell still discovers the right project. You won't usually set this
by hand. Precedence, highest first: `--config-dir`/`ME_CONFIG_DIR` (exact) >
`--project-dir`/`ME_PROJECT_DIR` (anchor) > cwd walk-up > a validated
harness-provided fallback (today: Claude's `CLAUDE_PROJECT_DIR`, accepted
only if it actually contains a `.me/`).

## Committed vs. local (`.me/config.local.yaml`)

A sibling `.me/config.local.yaml` overrides the committed `.me/config.yaml`
**per field** — the same split as Claude Code's `settings.json` vs
`settings.local.json`:

- **`.me/config.yaml`** — commit it to share the project's server/space/tree with
  everyone who clones the repo.
- **`.me/config.local.yaml`** — gitignore it; personal overrides that never leave
  your machine. This is how a **private** project keeps its home tree
  (`~/projects/…`) out of version control.

## Precedence

Each of `server` / `space` resolves highest-first:

```
--flag  >  ME_* env  >  .me/config.local.yaml  >  .me/config.yaml
        >  ~/.config/me global config  >  built-in default
```

So an explicit `--server` / `--space` (or `ME_SERVER` / `ME_SPACE`) still wins for
a one-off, and a project's `.me` beats your global default when you're working
inside it.

## Changing the pinned space (`me space use`)

You don't have to hand-edit the file to repoint a project: `me space use <space>`
writes to whichever config **currently defines** the effective space — the
`git config` model of editing the effective scope. Inside a project whose `.me`
defines `space`, it updates that pin (`.me/config.local.yaml` if it defines
`space`, since it overrides the committed file; else the committed
`.me/config.yaml` — comments are preserved). When no `.me` file defines `space`,
the global `~/.config/me/config.yaml` is updated as usual — a tree-only `.me`
keeps following your global active space. The command prints which file it
saved to.

## The `tree` field (for integrations)

`tree` is the **full project tree** — the exact node integrations write under, with
**no project slug appended**. Given `tree: /share/projects/acme`:

- Captured/imported agent sessions land under `/share/projects/acme/agent_sessions`
- Imported git history lands under `/share/projects/acme/git_history`

Contrast the default (no `.me`), where captures nest **privately** under
`~/projects/<auto-slug>/…` — your own home tree, visible only to you. Pinning
`tree` is how a project chooses its own home — e.g. a **shared** team subtree
(`/share/projects/acme`, so the whole team works off common memories), a
group-writable subtree that the team can still read (`/share/payments/acme`), or
a private group subtree outside `/share` (`/payments/acme`). See
[Projects](projects.md) for common layouts.

A leading `~` (your home) and `/`-separated paths are accepted; the path is
normalized server-side. An explicit `me import git --tree <path>` /
`me import <tool> --tree-root <path>` still overrides the `.me` tree for that
run.

The Claude/OpenCode capture hooks resolve the `.me` for the **session's**
project, so a single globally-installed plugin routes each project to its own
tree — and the bulk `me import <tool>` sweep does the same per session
(server/space/tree from each session's own project), so backfills and live
capture always agree.

## Changing the default tree root (`tree_root`)

Without a `.me` `tree`, captures and imports nest per project under a **tree
root** — `<tree_root>/<slug>/…` — which defaults to the private `~/projects`.
To change that default machine-wide, set `tree_root` in your **global**
`~/.config/me/config.yaml` (no command writes this; edit it by hand):

```yaml
# ~/.config/me/config.yaml
tree_root: ~/work        # captures now nest at ~/work/<slug>/…
```

Resolution, highest-first: an explicit `--tree-root` flag → the project's
`.me` `tree` (a full node — no slug appended) → the global `tree_root` →
`~/projects`. A leading `~` and `/`-separators are accepted; the path is
normalized server-side.

## The `capture` field (session capture on/off)

Session capture is **off by default** — the Claude capture hook ships inert.
Whether a session is captured resolves highest-first:

1. the project's `.me/config.yaml` **`capture`** —
   - `true`: capture this project's sessions **even if the member never opted
     in globally**. A committed `capture: true` (+ a shared `tree`) is what
     makes a team repo capture for everyone who clones it.
   - `false`: never capture this project (e.g. a sensitive repo) — this
     opt-out wins over every other setting.
2. else the **machine-wide** setting in `~/.config/me/config.yaml`
   (`capture: true`), written when you opt in at the `me claude install`
   prompt;
3. else **off**.

When capture is off the hooks exit silently — no error, nothing written. The
same resolution applies to the capture hooks that exist today (Claude Code and
OpenCode); `me claude install` and `me opencode install` both ask the capture
question and write the machine-wide flag. Codex and Gemini currently install
shell env hooks for agent-by-config, not session capture hooks.

## The `import` block (CI imports)

The optional `import:` block shapes the orchestrated CI run —
[`me import ci`](cli/me-import.md#me-import-ci), the command the scaffolded
GitHub workflow calls on every push to the default branch. Targeting
(server/space/tree) stays in the top-level fields; this block only controls
WHAT the run imports and which identity is expected to run it:

```yaml
import:
  git: true                       # run the git-history phase (default true)
  docs: true                      # run the docs phase (default true)
  docs_include: ["docs/**"]       # docs globs, replacing the default markdown set
  docs_exclude: ["docs/internal/**"]
  service_account: github-import  # the SA expected to hold the CI credentials
```

Like the rest of the schema it is **strict** — a typo'd key (`docs_includes:`)
is a fatal error, never a silently-widened walk.

`service_account` is read by [`me project ci`](cli/me-project.md#me-project-ci)
(setup/verify), **not** at import time — in CI the `ME_API_KEY` bearer *is* the
identity. The name is not a secret (any space member can resolve it).
Committing it is how an org using **per-project grants** makes onboarding
self-documenting: plain `me project ci` then verifies the shared account and
extends its grant to this repo's tree without anyone remembering a flag. Orgs
using a single parent-level grant (`write@/share/projects`) don't need it at
all.

## Agent-by-config and the `agent` field

A harness surface — the MCP server (`me mcp`), the capture hooks, and a plain
`me` call from an agent's own tool shell (Claude, OpenCode, and — soon — Codex
and Gemini CLI) — resolves and acts as the configured agent automatically,
with no `--as-agent` flag needed. This is what makes an agent's work
attributable (it shows up as that agent, not as you) and access-scoped (the
server clamps the agent to its own grants, whatever your own access is).

Resolution, per harness invocation:

1. the project's `.me/config.yaml` **`agent`**, else
2. the **global** `agent` in `~/.config/me/config.yaml`, else
3. **nothing in scope** — `me mcp` fails to start with an actionable error;
   the capture hooks silently skip (never captures as you); a harness's own
   shell errors rather than falling back to your credentials.

Case 3 is rare in practice: every `me claude install` / `me opencode install`
provisions-or-adopts a default agent (named `coder`) and writes it as the
global fallback the first time you install (skip with `--no-default-agent`). If
a global `agent:` is already set but does not resolve to an agent you own, an
interactive install offers to create it; a non-interactive install fails with an
actionable error instead of leaving harnesses broken.

### The `.user` sentinel — opting a project (or machine) out

Sometimes you deliberately want harness work to run as **you** — a personal
project, a script you trust. Set `agent: .user` in `.me/config.local.yaml`
(never the committed `.me/config.yaml` — see below) or in your global
`~/.config/me/config.yaml`, or pass `--as-agent .user` / `ME_AS_AGENT=.user`
on a one-off invocation.

A **committed** `agent: .user` is a fatal `ProjectConfigError` — a repo author
writing it into the tracked `.me/config.yaml` would silently switch every
cloning teammate's harness surfaces to their own full user credentials, which
is a bigger blast radius than a committed `agent: <name>` (that can at worst
403, since names resolve against the caller's own agents). Put it in
`.me/config.local.yaml` (gitignored, personal) instead.

See [MCP Integration](mcp-integration.md) for how this plays out for `me
mcp`, and the harness-injected shell contract that makes a plain `me` call
from an agent's own tool shell resolve the same way.
