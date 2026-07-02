# `me project init` — interactive wizard flow

Status: **target interactive flow** (design; companion to
`CLAUDE_INTEGRATION_DESIGN.md`).

The wizard runs in four ordered steps:

1. **Memory visibility** — public vs private.
2. **Tree root** — where this project's memories live (pre-filled from step 1).
3. **Memory access** — all, or a subset? (a subset opens **3a**: pick the agent)
4. **Setup checklist** — a multiselect of the setup steps to run.

## 1. Memory visibility (public vs private)

The wizard's first question decides **where this project's memories live**:

```
Do you want memories for this project to be public or private?
  ● Public (recommended) — shared with your whole team; everyone on the space
    works off the same common memories
  ○ Private — only you can see this project's memories
```

- **Default: Public**, and it's the **recommended** choice — the value of project
  memory is a shared pool the whole team builds on and benefits from (decisions,
  conventions, history), rather than each person keeping their own silo.
- **Private** keeps this project's memories in your personal home, visible only to
  you.

This choice sets the **default** for the next question: **Public** pre-fills a
path under the space's shared root (`share`); **Private** pre-fills one under your
personal home (`~`).

## 2. Tree root

A freeform text field for the path this project's memories nest under —
**pre-filled** from the visibility choice in step 1, and fully editable:

```
Where should this project's memories live?
> /share/projects/my-project      ← Public (default)
```
```
Where should this project's memories live?
> ~/projects/my-project           ← Private
```

- `my-project` is a **slug derived from the current directory**.
- The prefix follows step 1 (`/share/projects/…` for public, `~/projects/…` for
  private). The user can accept the default or type any path.
- The confirmed value becomes the project tree root written to `.me/config.yaml`.

## 3. Memory access (all vs a subset)

Asks how much of *your* memory Claude in this project should be able to see:

```
Should Claude see all your memories, or only a subset?
  ● All (default) — Claude runs as you and can see everything you can
  ○ A subset — Claude runs as a dedicated agent limited to the memories you choose
```

- **All** → we **don't** run as an agent; the integration runs as **you** (your
  login session), so Claude sees every memory you can. No `agent:` is written to
  `.me/config.yaml`.
- **A subset** → we run as a **dedicated agent** scoped to the memories you pick,
  written as `agent:` in `.me/config.yaml`. This opens a follow-up (step 3a) to
  choose the agent.

### 3a. Which agent? (only if "a subset" was chosen)

```
How should the agent for this project be set up?
  ● This project only — create an agent that can see just this project (default)
  ○ Reuse an existing agent — pick one of your agents; its existing grants apply
  ○ Empty agent — create one with no grants; I'll set up its access myself
```

- **This project only** — creates a new agent (named in step 3ac) and grants it
  access to the tree root from step 2, so it sees exactly this project's memories
  and nothing else. The turnkey "subset = this project" choice.
- **Reuse an existing agent** — opens step 3ab to pick from your existing agents;
  whatever that agent can already see is what Claude sees here. Nothing new is
  granted. (Not offered when you have no agents yet.)
- **Empty agent** — creates the agent (named in step 3ac) with no grants and
  stops there; you wire up its access yourself afterward (e.g. `me access grant
  …`). Claude sees nothing until you do.

The chosen agent's name is written as `agent:` in `.me/config.yaml`.

#### 3ab. Pick the agent (only if "reuse an existing agent" was chosen)

A single-select list of your existing agents:

```
Which agent should this project use?
  ● claude-code-agent   — read+write on share.projects
  ○ research-bot        — read on share.research
  ○ …
```

- Lists the agents you own in this space, each with a hint of what it can already
  see. Selecting one writes its name as `agent:` in `.me/config.yaml` and uses
  its **existing** grants unchanged — the wizard grants nothing new.
- If you have no agents yet, the "reuse" option isn't offered back in 3a, so this
  step never appears.

#### 3ac. Name the agent (only if "this project only" or "empty agent" was chosen)

A freeform text field for the new agent's name:

```
Name for the new agent:
> claude-code-agent-my-project
```

- Pre-filled with `claude-code-agent-<project-slug>` (`<project-slug>` is the same
  slug derived from the current directory as the tree root in step 2).
- The pre-fill is a **free** name: if `claude-code-agent-<project-slug>` already
  exists, it's bumped to the next available variant, so confirming always creates
  a new agent rather than colliding.
- The confirmed name is the agent we create — granted the project tree root
  ("this project only") or nothing ("empty agent") — and written as `agent:` in
  `.me/config.yaml`.

## 4. Setup checklist

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
  already-installed plugin (`me claude install`); this row just turns it on for
  this project (a flag in `.me/config.yaml`), so a project can opt out.
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

A user logged into space `acme-eng`, running `me project init` in
`~/dev/acme-api` (a git repo, Claude Code on PATH), accepting every default —
just pressing enter at each prompt:

```
1. Do you want memories for this project to be public or private?
   > ● Public (recommended)                    ⏎

2. Where should this project's memories live?
   > /share/projects/acme-api                  ⏎

3. Should Claude see all your memories, or only a subset?
   > ● All                                      ⏎
     └─ "All" → no agent, so steps 3a/3ab/3ac are skipped.

4. Setup steps to run:
   ◉ Import this project's existing Claude Code sessions (one-time backfill)
   ◉ Enable ongoing capture of new Claude Code sessions for this project
   ◉ Import existing git commit history (one-time backfill)
   ◉ Install a git post-commit hook — captures new commits going forward
   ◉ Add a memory pointer to CLAUDE.md
   > ⏎ (accept all)
```

Result:

- Writes `.me/config.yaml` — **no `agent:`** (runs as the user):
  ```yaml
  server: https://api.memory.build
  space: acme-eng
  tree: /share/projects/acme-api
  ```
- Backfills this repo's past Claude sessions + git history, enables ongoing
  session capture for the project, installs the git post-commit hook, and adds the
  CLAUDE.md pointer. (The capture plugin itself is already installed once via
  `me claude install` — not part of init.)

So the happy path is **four enters**: public, accept the tree root, all-memories,
run everything — no agent provisioning, no branching.
