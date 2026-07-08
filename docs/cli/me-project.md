# me project

Harness-agnostic per-project setup.

## Commands

- [me project init](#me-project-init) -- configure this project's memory: space, location, agent, and the setup checklist

---

## me project init

Set up the current project's Memory Engine integration. Interactively it runs a wizard and then a setup checklist; non-interactively (piped / scripted) it runs just the checklist, honoring the `--skip-*` flags.

```
me project init [options]
```

No plugin is installed per project: the single user-scoped plugin ([`me claude install`](me-claude.md#me-claude-install), run once) picks the configuration up from the committed `.me/config.yaml` this wizard writes. Teammates who have run `me claude install` get the project's behavior just by cloning — no per-repo install.

### Preflight

Before any question, the wizard checks two prerequisites and offers to fix each:

- **Not logged in** → offers to run `me login`. A session is required (the wizard lists your spaces and creates agents), so **declining stops**.
- **Plugin not installed** (Claude Code on PATH, plugin missing) → offers to run the [`me claude install`](me-claude.md#me-claude-install) flow, which itself pins global defaults and asks about capture. Not required to write the config, so **declining continues with a warning**.

When both are already in place, preflight is silent.

### 0. Space

Pick which space this project's memories live in — the list of spaces you belong to (defaulting to your active space), or **create a new space** (you become its admin/owner, and it becomes your active space). The chosen space is written as `space:` in `.me/config.yaml` together with `server:` (a space lives on one server, so a committed config resolves the same for every teammate).

### 1. Where should this project's memories live?

One choice combining visibility with the tree root — `<slug>` is derived from the project (git `origin` repo name → git root directory name → directory basename):

- **`/share/projects/<slug>`** (default) — public: shared with the whole team.
- **`~/projects/<slug>`** — private: your own home tree, visible only to you.
- **(custom)** — type any tree root.

Written as `tree:` in `.me/config.yaml`; captures and imports nest under it (`<tree>/agent_sessions`, `<tree>/git_history` — no slug appended).

### 2. Agent

The wizard always sets the project up with a dedicated agent (there's no "run as my own user" option here — though the `agent` field itself is optional in the config schema):

- **Create a new agent with access to the whole space** (default) — created, added to the space, and granted **write** at the space root. The server clamps an agent to `least(agent, owner)` per path, so a root grant gives it exactly what you can reach — never more.
- **Create a new agent with access to only this project** — same, but the write grant lands on the step-1 tree.
- **Use an existing agent** — pick one of your agents already in the chosen space; its existing grants apply unchanged. (Hidden when you have none there.)

New-agent names prefill `<slug>-agent`, bumped to a free variant. The agent's name is written as `agent:` in `.me/config.yaml` — every harness surface (MCP, the capture hooks, a plain `me` call from an agent's own shell) resolves and acts as this agent automatically, no separate settings pin needed (see [Agent-by-config](../project-config.md#agent-by-config-and-the-agent-field)). If an older `me project init` had pinned a literal `ME_AS_AGENT=<name>` into the project's `.claude/settings.json`, this run removes it — a leftover value there would otherwise silently override the injected `.me` sentinel.

> **Team caveat**: `agent:` resolves only against the caller's **own** agents, so a committed `agent:` works for the teammate who created it. Other teammates should run `me project init` themselves (choosing "use an existing agent" or creating their own) — see the design notes for the open team-agent-identity question.

### 3. Setup checklist

A grouped multiselect, everything pre-checked (non-interactive runs execute all of it minus the `--skip-*` flags):

| Group | Step | Skip flag | What it does |
|-------|------|-----------|--------------|
| Claude Code sessions | Import this project's existing Claude Code sessions (one-time backfill) | `--skip-transcript-import` | Backfills sessions recorded in this repo. Reads the just-written `.me` `tree`, so the backfill lands exactly where live capture writes. |
| Claude Code sessions | Enable ongoing capture of new Claude Code sessions | `--skip-capture-enable` | Writes `capture: true` to `.me/config.yaml` — the committed, per-project capture opt-in the installed plugin's hooks honor (it wins over each member's global setting). Interactively **deselecting** this row writes an explicit `capture: false`, so the committed config is deterministic for the team; non-interactively, `--skip-capture-enable` just leaves the file untouched. |
| Git history | Import existing git commit history (one-time backfill) | `--skip-git-import` | Same import as [`me import git`](me-import.md#me-import-git). Hidden outside a git repo. |
| Git history | Install a git post-commit hook | `--skip-git-hook` | The managed hook from [`me import git-hook`](me-import.md#me-import-git-hook). Hidden outside a git repo or when a hooks manager owns the hook path. |
| Project config | Add a memory pointer to CLAUDE.md | `--skip-claude-md` | Upserts a managed block naming the project tree and how to search it. Replaces an existing block in place — including one written under the old `me claude init` name. |

Steps already done are offered unchecked as idempotent re-runs (non-interactive runs report them as ✓ lines and skip them). Re-running `me project init` is safe throughout: the imports are incremental/idempotent and the config writes preserve comments.

> **Harness-agnostic TODO**: the session-backfill and CLAUDE.md rows are still Claude-specific; a fuller `me project init` will gate them on the harness in scope.

### Example: the default flow

Already logged in, plugin installed, running in `~/dev/acme-api` (a git repo): preflight is silent and the happy path is five enters — active space, public location, a whole-space agent, its pre-filled name, run everything. Result:

```yaml
# .me/config.yaml (committed)
server: https://api.memory.build
space: acme-eng
tree: /share/projects/acme-api
agent: acme-api-agent
capture: true
```

plus the backfills, the git hook, and the CLAUDE.md pointer.

### Deprecated alias

`me claude init` now prints a rename notice and runs this command; the alias will be removed in a future release.
