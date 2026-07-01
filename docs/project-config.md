# Project config (`.me/config.yaml`)

A project can pin its Memory Engine **server** and **space** — and, optionally, the
**tree** its integrations write to — in a `.me/config.yaml` file at the repo root.
Any `me` invocation inside the project (the CLI, the `me mcp` server, the
Claude/OpenCode capture hooks, `me import git`) then targets that server and space
automatically, with no per-command flags or environment variables.

This is what lets a project say "my memories live in space `X` on server `Y`,
under tree `Z`" once, and have every tool that touches the repo agree.

## The file

```yaml
# .me/config.yaml
server: https://api.memory.build   # pin the server
space: xjjg3kmq6vvb                 # pin the space (slug)
tree: /share/projects/acme          # optional: where integrations write (see below)
```

All fields are optional. A `.me` that sets only `tree` still inherits its
server/space from your global config. A **malformed** file — invalid YAML, or a
field that fails validation — is a hard error: `me` fails with a clear message
rather than silently ignoring the pins the project meant to apply. (The
best-effort capture hooks are the exception — they log and skip, so a typo never
breaks an agent session.)

> `agent:` is reserved for a future "act as an agent" mode and currently has no
> effect.

## Discovery

`me` finds the config by walking **up** from the current directory to the first
ancestor that contains a `.me/config.yaml` — so it works from any subdirectory of
the project, just like `.git`.

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

## The `tree` field (for integrations)

`tree` is the **full project tree** — the exact node integrations write under, with
**no project slug appended**. Given `tree: /share/projects/acme`:

- Captured/imported agent sessions land under `/share/projects/acme/agent_sessions`
- Imported git history lands under `/share/projects/acme/git_history`

Contrast the default (no `.me`), where captures nest under
`<share/projects>/<auto-slug>/…`. Pinning `tree` lets a project choose its own
home — e.g. a team subtree (`/share/teams/backend`) or a private one
(`~/projects/acme`, which resolves to your own home per user).

A leading `~` (your home) and `/`-separated paths are accepted; the path is
normalized server-side. An explicit `--tree-root` flag on an import still
overrides the `.me` tree.

The Claude/OpenCode capture hooks resolve the `.me` for the **session's** project,
so a single globally-installed plugin routes each project to its own tree.
