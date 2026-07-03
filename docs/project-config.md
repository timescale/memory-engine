# Project config (`.me/config.yaml`)

A project can pin its Memory Engine **server** and **space** — and, optionally, the
**tree** its integrations write to — in a `.me/config.yaml` file at the repo root.
Any `me` invocation inside the project (the CLI, the `me mcp` server, the
Claude/OpenCode capture hooks, `me import git`) then targets that server and space
automatically, with no per-command flags or environment variables.

This is what lets a project say "my memories live in space `X` on server `Y`,
under tree `Z`" once, and have every tool that touches the repo agree.

The interactive [`me project init`](cli/me-project.md) wizard writes this file
for you — `server` + `space` (pinned together, so a committed config is
self-contained), the `tree`, a dedicated `agent`, and the `capture` flag — and
also pins `ME_AS_AGENT=<agent name>` into the project's committed
`.claude/settings.json` `env` so ad-hoc `me` calls from Claude's Bash tool act
as the project agent too (the literal name, not the `.me` sentinel — the Bash
tool runs from arbitrary directories where a `.me` walk-up wouldn't resolve;
personal overrides belong in Claude's own `settings.local.json`).

## The file

```yaml
# .me/config.yaml
server: https://api.memory.build   # pin the server
space: xjjg3kmq6vvb                 # pin the space (slug)
tree: /share/projects/acme          # optional: where integrations write (see below)
agent: acme-agent                   # optional: the project's agent (see below)
capture: true                       # optional: session capture on/off (see below)
```

All fields are optional. A `.me` that sets only `tree` still inherits its
server/space from your global config. A **malformed** file — invalid YAML, or a
field that fails validation — is a hard error: `me` fails with a clear message
rather than silently ignoring the pins the project meant to apply. (The
best-effort capture hooks are the exception — they log and skip, so a typo never
breaks an agent session.)

> `agent:` names the project's default agent and is the value source for the
> `.me` sentinel: `--as-agent .me` / `ME_AS_AGENT=.me` resolves to it and sends
> `X-Me-As-Agent`. It never activates agent mode on its own — activation is
> always explicit via the flag/env.

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
walk and uses that directory's `.me/` directly.

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
(`/share/projects/acme`, so the whole team works off common memories) or a
different private one.

A leading `~` (your home) and `/`-separated paths are accepted; the path is
normalized server-side. An explicit `me import git --tree <path>` still
overrides the `.me` tree for that run. (The bulk `me import <tool>` sweep uses
`--tree-root` instead — a *parent* under which each project nests by slug —
since it spans many projects.)

The Claude/OpenCode capture hooks resolve the `.me` for the **session's** project,
so a single globally-installed plugin routes each project to its own tree.

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
same resolution applies to **every** harness's hooks (Claude and OpenCode
alike); `me claude install` and `me opencode install` both ask the capture
question and write the machine-wide flag.
