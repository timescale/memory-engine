# me project

Harness-agnostic per-project setup. For guidance on choosing between
team-writable layouts such as `/share/projects/<project>`, group-writable layouts
such as `/share/<group>/<project>`, and private group layouts outside `/share`,
see [Projects](../projects.md).

## Commands

- [me project init](#me-project-init) -- configure this project's memory: space, location, and the setup checklist

---

## me project init

Set up the current project's Memory Engine integration. Interactively it runs a wizard and then a setup checklist; non-interactively (piped / scripted) it runs just the checklist, honoring the `--skip-*` flags.

```
me project init [options]
```

No plugin is installed per project: a single user-scoped install per harness ([`me claude install`](me-claude.md#me-claude-install) / [`me opencode install`](me-opencode.md#me-opencode-install), each run once) picks the configuration up from the committed `.me/config.yaml` this wizard writes. Teammates who have already installed their harness get the project's behavior just by cloning — no per-repo install.

### Preflight

Before any question, the wizard checks two prerequisites and offers to fix each:

- **Not logged in** → offers to run `me login`. A session is required (the wizard lists your spaces and may create one), so **declining stops**.
- **No harness set up yet at all** → a multiselect offering to set up every harness detected as installed on this machine but not yet configured (today: Claude Code, OpenCode). Selecting one runs its install flow ([`me claude install`](me-claude.md#me-claude-install) / [`me opencode install`](me-opencode.md#me-opencode-install), always at OpenCode's default **user** scope here — run the standalone command yourself with `--scope project` if you want a team-committed OpenCode setup instead), which itself pins global defaults and asks about capture. Not required to write the config, so **declining any of them continues with a warning**. Once **any** harness is already set up, this whole step is skipped silently — per-project init doesn't nag about additional harnesses you may not use.

When logged in and at least one harness is already set up, preflight is silent.

### 0. Space

Pick which space this project's memories live in — the list of spaces you belong to (defaulting to your active space), or **create a new space** (you become its admin/owner, and it becomes your active space). The chosen space is written as `space:` in `.me/config.yaml` together with `server:` (a space lives on one server, so a committed config resolves the same for every teammate).

### 1. Where should this project's memories live?

One choice combining visibility with the tree root — `<slug>` is derived from the project (git `origin` repo name → git root directory name → directory basename):

- **`/share/projects/<slug>`** (default) — public: shared with the whole team.
- **`~/projects/<slug>`** — private: your own home tree, visible only to you.
- **(custom)** — type any tree root.

Written as `tree:` in `.me/config.yaml`; captures and imports nest under it (`<tree>/agent_sessions`, `<tree>/git_history` — no slug appended).

In a default space, `/share/projects/<slug>` is writable by the default `team`
group. Use a custom tree such as `/share/payments/<slug>` when the team should
read but only a subgroup should write; use a path outside `/share` when the
project should not be broadly readable. Grant the target group write access
before or after running the wizard. Creating groups is space-admin-only;
granting access requires owner access at the target path, so you may need help
from a space admin or path owner for these patterns.

### 2. Setup checklist

A grouped multiselect, everything pre-checked (non-interactive runs execute all of it minus the `--skip-*` flags). The transcript-import and memory-pointer rows are **harness-gated** — hidden automatically when they don't apply, rather than always assuming Claude:

| Group | Step | Skip flag | What it does |
|-------|------|-----------|--------------|
| Claude Code sessions | Import this project's existing Claude Code sessions (one-time backfill) | `--skip-transcript-import-claude` | Backfills sessions recorded in this repo. Reads the just-written `.me` `tree`, so the backfill lands exactly where live capture writes. **Hidden** when this project has no Claude Code sessions at all. |
| Codex sessions | Import this project's existing Codex sessions (one-time backfill) | `--skip-transcript-import-codex` | Same, for Codex. **Hidden** when this project has no Codex sessions. |
| OpenCode sessions | Import this project's existing OpenCode sessions (one-time backfill) | `--skip-transcript-import-opencode` | Same, for OpenCode. **Hidden** when this project has no OpenCode sessions. |
| Session capture | Enable ongoing capture of new agent sessions | `--skip-capture-enable` | Writes `capture: true` to `.me/config.yaml` — the committed, per-project capture opt-in honored by the Claude Code and OpenCode capture hooks (it wins over each member's global setting). One flag covers the capture hooks that exist today; interactively **deselecting** this row writes an explicit `capture: false`, so the committed config is deterministic for the team; non-interactively, `--skip-capture-enable` just leaves the file untouched. |
| Project config | Add a memory pointer to CLAUDE.md | `--skip-claude-md` | Upserts a managed block naming the project tree and how to search it. **Hidden** unless Claude Code is installed on this machine. |
| Project config | Add a memory pointer to AGENTS.md | `--skip-agents-md` | Same, for `AGENTS.md` — the convention OpenCode and Codex both read. **Hidden** unless OpenCode or Codex is installed on this machine. |

Steps already done are offered unchecked as idempotent re-runs (non-interactive runs report them as ✓ lines and skip them). Re-running `me project init` is safe throughout: the imports are incremental/idempotent and the config writes preserve comments.

### Example: the default flow

Already logged in, plugin installed, running in `~/dev/acme-api` (a git repo): preflight is silent and the happy path is three enters — active space, public location, run everything. Result:

```yaml
# .me/config.yaml (committed)
server: https://api.memory.build
space: acme-eng
tree: /share/projects/acme-api
capture: true
```

plus the session backfills, the CI import workflow, and the CLAUDE.md pointer.

### Deprecated aliases

`me claude init` and `me opencode init` are removed. They print an error pointing at this command and exit without running the wizard.

---

## Deprecated command

`me project ci` is a temporary deprecated redirect. Run [`me ci install`](me-ci.md#me-ci-install) instead.
