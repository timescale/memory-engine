# `me project init` — interactive wizard flow

Status: **target interactive flow** (design; companion to
`CLAUDE_INTEGRATION_DESIGN.md`).

A **preflight** ensures your prerequisites first (below); then the wizard runs in
four ordered steps (0–3):

0. **Space** — which space this project's memories live in (or create one).
1. **Memory location** — public, private, or a custom tree root.
2. **Agent** — how this project's agent is set up (new/whole-space, new/this-project, or existing).
3. **Setup checklist** — a multiselect of the setup steps to run.

## Preflight — login + plugin

Before any question, `me project init` checks two prerequisites and offers to fix
each (with a confirmation):

- **Not logged in** → *"You're not logged in to Memory Engine — log in now?"* →
  runs `me login`. The wizard needs a session to list your spaces and create
  agents, so **declining stops here**.
- **Plugin not installed** → *"The Memory Engine plugin isn't installed for Claude
  Code — install it now?"* → runs `me claude install` (which itself asks about
  capture, pins global defaults, etc.). Not required to *write* the config, but
  capture/tools won't work until it's installed, so **declining continues with a
  warning**.

Login is checked first (install needs a session). When both are already in place,
preflight is silent.

## 0. Space

First, pick which space this project's memories live in:

```
Which space should this project use?
  ● acme-eng (active)   — your current active space
  ○ personal
  ○ acme-research
  ○ + Create a new space…
```

- Lists the spaces you're a member of; **defaults to your active space**.
- **Create a new space…** — pick this when the project shouldn't live in any
  existing space. It then **prompts you for a new space name**, provisions that
  space (you become its admin/owner), and uses it for this project.
- Written as `space:` in `.me/config.yaml` (**required** — a committed project must
  be deterministic). The **server** is pinned alongside it (a space lives on one
  server), so teammates resolve the same space without relying on their own active
  one.

## 1. Where should this project's memories live?

One choice that combines visibility with the tree root — pick a ready-made path
or enter a custom one:

```
Where should this project's memories live?
  ● /share/projects/my-project   ← Public (default) — shared with the whole team
  ○ ~/projects/my-project        ← Private — only you can see them
  ○ (custom)                     — type any tree root
```

- `my-project` is a **slug derived from the current directory**.
- **Public** (default, recommended) nests under the space's shared root (`share`)
  so the whole team works off common memories; **Private** nests under your home
  (`~`), visible only to you.
- **(custom)** opens a freeform field to type any tree root.
- The chosen path is written as `tree:` in `.me/config.yaml`.

## 2. Agent

The wizard always sets this project up with a dedicated **agent** — there's **no
"use my own user permissions" option** here (the `agent` field is optional in the
config, but the wizard doesn't offer the no-agent path). Choose how:

```
How should an agent for this project be set up?
  ● Create a new agent with access to the whole space (default)
  ○ Create a new agent with access to only this project
  ○ Use an existing agent
```

- **New agent, whole space** — creates a new agent (named in step 2a) granted
  access across the **entire space** you chose in step 0, so it sees everything in
  that space (like you do). The default.
- **New agent, this project only** — creates a new agent (named in step 2a)
  granted access to just this project's tree root (from step 1), so it sees only
  this project's memories.
- **Use an existing agent** — pick one of your agents (step 2b); its existing
  grants apply unchanged. (Not offered when you have no agents yet.)

The chosen/created agent's name is written as `agent:` in `.me/config.yaml`.

### 2a. Name the new agent (only if a "create a new agent" option was chosen)

A freeform text field for the new agent's name:

```
Name for the new agent:
> my-project-agent
```

- Pre-filled with `<project-slug>-agent` (`<project-slug>` is the same slug derived
  from the current directory as the tree root in step 1). **No harness prefix** —
  one `.me/` can serve multiple harnesses, so the agent isn't Claude-specific.
- The pre-fill is a **free** name: if `<project-slug>-agent` already exists, it's
  bumped to the next available variant, so confirming always creates a new agent
  rather than colliding.
- The new agent is granted **whole-space** or **this-project-only** access per your
  step-2 choice, and written as `agent:` in `.me/config.yaml`.

### 2b. Pick the agent (only if "use an existing agent" was chosen)

A single-select list of your existing agents:

```
Which agent should this project use?
  ● acme-api-agent      — read+write on share.projects
  ○ research-bot        — read on share.research
  ○ …
```

- Lists the agents you own in this space, each with a hint of what it can already
  see. Selecting one writes its name as `agent:` in `.me/config.yaml` and uses its
  **existing** grants unchanged — the wizard grants nothing new.
- If you have no agents yet, the "use an existing agent" option isn't offered in
  step 2, so this step never appears.

## 3. Setup checklist

Next, the wizard shows a grouped, pre-checked multiselect —
**everything is selected by default**; the user toggles off what they don't want:

```
Setup steps to run (all selected by default — ↑/↓ move, space to toggle off/on, enter to confirm)

Claude Code sessions
  ◉ Import this project's existing Claude Code sessions (one-time backfill)
  ◉ Enable ongoing capture of new Claude Code sessions for this project
Git history
  ◉ Import existing git commit history (one-time backfill)
  ◉ Install a git post-commit hook — captures new commits going forward
Project config
  ◉ Add a memory pointer to CLAUDE.md
```

Three groups, five rows:

- **Claude Code sessions** — backfill this repo's past sessions, and **enable
  ongoing capture** of new ones for this project. The capturing is done by the
  already-installed plugin (`me claude install`); this row writes a `capture` flag
  to `.me/config.yaml` that turns it on for this project **regardless of your
  global capture setting** (uncheck to keep it off here).
- **Git history** — backfill the repo's commit history; install a post-commit
  hook so future commits are captured.
- **Project config** — add a managed memory-pointer block to `CLAUDE.md`.

> **Harness-agnostic TODO:** these rows are still Claude/repo-specific (session
> backfill, CLAUDE.md pointer). A fuller `me project init` should offer only the
> harness-neutral steps here (or detect the harness) — see
> `CLAUDE_INTEGRATION_DESIGN.md`. Left for a follow-up.

## Interaction

- ↑/↓ move, **space** toggles a row off/on, **enter** confirms.
- Groups are headings only — they can't be toggled as a unit.
- **Cancel** exits without doing anything.
- Deselect everything → *"No setup steps selected — nothing to do."*

## How rows adapt

- **Already done** → the row appears **unchecked** with a refresh label, so a
  re-run is opt-in rather than default:
  - *"Reinstall the git post-commit hook … (already installed)"*
  - *"Rewrite the memory pointer in CLAUDE.md (already present)"*
- **Not applicable** → the row is **hidden** entirely:
  - both git rows are gone outside a git repo (or when another hooks manager owns
    the hook path).

## Example: the default flow

A user already logged in (space `acme-eng`) with the plugin installed, running
`me project init` in `~/dev/acme-api` (a git repo, Claude Code on PATH) — so
**preflight is silent** — and accepting every default, just pressing enter at each
prompt:

```
0. Which space should this project use?
   > ● acme-eng (active)                        ⏎

1. Where should this project's memories live?
   > ● /share/projects/acme-api  (Public)       ⏎

2. How should an agent for this project be set up?
   > ● Create a new agent with access to the whole space   ⏎

2a. Name for the new agent?
   > acme-api-agent                             ⏎

3. Setup steps to run:
   ◉ Import this project's existing Claude Code sessions (one-time backfill)
   ◉ Enable ongoing capture of new Claude Code sessions for this project
   ◉ Import existing git commit history (one-time backfill)
   ◉ Install a git post-commit hook — captures new commits going forward
   ◉ Add a memory pointer to CLAUDE.md
   > ⏎ (accept all)
```

Result:

- Writes `.me/config.yaml` — with a whole-space `agent:`:
  ```yaml
  server: https://api.memory.build
  space: acme-eng
  tree: /share/projects/acme-api
  agent: acme-api-agent
  ```
- Backfills this repo's past Claude sessions + git history, enables ongoing
  session capture for the project, installs the git post-commit hook, and adds the
  CLAUDE.md pointer. (The capture plugin itself is already installed once via
  `me claude install` — not part of init.)

So the happy path is **five enters**: active space, public location, a whole-space
agent, its (pre-filled) name, run everything.
