

One of the primary reasons we explored having a privilege model in memory engine was to be able to constrain agents.
We wanted not only to restrict their writes (we may not want to risk an agent deleting certain memories) but also to limit their reads, which is useful for context engineering.
Naturally, a human user will need to be able to do anything in their own space.
So, to constrain an agent, we need a first-class user model with access controls.
This feature has the happy accident of also allowing multi-human sharing of a space.

We created a new kind of principal called an "agent."
Each agent is owned by a human user who can self-administer the agent.
We special-cased the access model so that agent access is capped by the owner's access.
The use-case for these added features is a coding harness.

If a coding agent is running using the human user's credentials, the user has no effective means to constrain what the coding harness agent is able to do in memory engine.
When a human is using a coding harness with memory engine, the coding harness should use an agent owned by that human.
This gives the human user has the ability to tailor the access of that agent to the project and/or task at hand by self-administering the agent's access.
By default, the agent can have all the access the human has (i.e. write@/ capped by the owner's own access).
The owner can then restrict down as desired.

The actions of a coding agent should be attributable to that agent.
Because each agent is owned by one and only one user, you get transitive attribution to the user for free.
When a user has employed multiple agents doing different tasks, having the actions attributable to specific agents aids in observability.

We don't claim or endeavor to constrain a malicious agent.
That is the job of a sandbox environment.
If a user wants to ensure an agent is constrained, the coding harness should run in a sandbox with only a ME_API_KEY for credentials.
We should fully support this mode.

On the other hand, since restricting an agent's operations in memory engine is the whole point of all of these implemented features,
we should strive to:
1. make using an agent in a coding harness the default
2. make using an agent in a coding harness relatively easy
3. make a coding harness accidentally operating as the owning user relatively hard and rare (if not impossible)

At the same time, when a human user is working with the me cli in a terminal:
1. it should operate with the human user's authorization
2. actions should be attributed to the human
3. this should be easy. i.e. the human shouldn't have to do "extra stuff" for the cli to behave

We have a few situations to consider:
1. a coding harness with the me mcp server connected
2. a coding harness where the agent shells out to run the me cli
3. harness integrations like hooks
4. a coding harness where the agent writes a script with the me client
5. the human using the cli

We want 1-3 to use the agent for authorization or fail closed. Ideally, 4 would act the same, but let's leave it as an advanced consideration for now.
So, we need a way to put the mcp and cli into a use an agent-or-die state.
We want to force the mcp/cli to use the agent and ideally explicitly point it at the correct config dir so it can find the correct settings.

The main integration point is the MCP server. Ultimately, it only needs to know:

- the server
- the space
- which agent to run as

Users of the hosted service will use the default server (the hosted service), and thus don't really need to specify a server.
Users of a self-hosted memory engine will need to specify their server, potentially globally.
Users of a mixture of hosted and self-hosted memory engines (should be rare) will have to specify their server per situation.

A configured tree path only comes into play when you want to import and/or stream via hooks your session transcripts and/or git commits.
This is optional, though we'd like it to be default on.

We DO know that saving session transcripts is a controversial feature.
We have people who do not want their session transcripts saved.
We have people who are okay with them being saved as long as they are kept private.
We have people who are okay with transcripts being saved in a public tree path.
Likely, some people will have different answers for different sessions/projects.
Some may want session transcripts in one tree, git commits in another, and other project memories in another.

For a given project that is shared among a team of people all of whom are using memory engine,
the server and space should be the same. The tree path is the same IIF the users all want their
sessions and git commits ingested to a public tree path.
If the users do not want to share their session transcripts, then the tree path is not a shared config.

The agent identity is NOT a shared piece of config. The agents' names *might* be the same, but their IDs will not be.

Thus, checking in the memory engine config is of limited utility anyway.

1. server - likely default
2. space - no big deal
3. tree - optional
4. agent - custom anyway

But if we did want to check in the config, we only really need to focus on 1-3.

**Ultimately, every user must run at least one me command at least once to get integrations working on a machine.**
**Ultimately, every user must touch the me config _in each project_ at least once to set the agent they want to use (minimally).**

A few things follow directly from this.

First, the agent identity is per-user, so it never belongs in a checked-in file. That settles the earlier question of whether to commit an agent name: we don't.

Second, because checking in config is low-value and only ever covers server/space/tree, a committed `.me/config.yaml` is at most a convenience — never load-bearing. The design must not depend on it for correctness; it can only be an accelerant.

Third, of the three things the MCP server needs — server, space, agent — only the agent is hard. The server defaults, and the space is cheap to set once. So the whole problem reduces to a single question: how does each integration point reliably run as the right per-user agent, or fail closed?

Two problems we had been conflating come apart cleanly once that is the question.

Activation and discovery are separate. Activation — putting the mcp and cli into a "use an agent or die" state — is just a static literal: `ME_AS_AGENT=.me` in the tool shell and `--as-agent .me` on the commands we author. That needs no variable interpolation and works on all four harnesses, since Claude's settings `env`, Codex's `shell_environment_policy`, Gemini's `.env`/settings, and opencode's plugin all accept a literal string. So making the agent the default (goal 1) and making it hard to accidentally run as the user (goal 3) are both cheap and portable. Discovery — finding the right `.me/config.local.yaml` when the agent shells out `me` from some other directory — is the only genuinely hard part, and it only affects whether things are easy, never whether they are safe.

Fail-closed is what makes the hard part safe. If activation is `.me` and discovery fails, resolution throws and the command dies. It never silently falls back to running as the owner. So even the unsolved case — an ad-hoc `me` invocation from an arbitrary working directory — degrades to a hard failure, not a privilege escalation. The discovery mechanisms are a convenience; they are not what keeps us safe.

And the MCP server, which is our main integration point, is the easy case regardless: every harness launches it with the project as its working directory, so discovery just works there and nothing extra is needed.

## Harnesses

Claude Code gets a lot of press and is obviously popular, but it is by no means the only harness in town.
Codex and Gemini are arguably just as prolific. For certain users, opencode and pi are even more important.

We want a solution that supports the widest set of harnesses possible. We don't want to focus solely on Claude Code, and we don't want to code for what works in Claude Code only to find that the approaches won't work for other harnesses.

- claude code
- codex
- opencode
- gemini
- pi

A Pi integration would look like fully custom code, so we can omit it from the analysis. Custom code can do basically anything.

## Harness Scopes

Every harness we care about (setting Pi aside) has both a user scope and a project scope for integrations, and some also have a personal-local scope.

| Harness | User scope | Project scope | Local/personal scope |
|---|---|---|---|
| **Claude Code** | `~/.claude/settings.json`, `~/.claude.json` (MCP), `~/.claude/skills`, `~/.claude/commands` | `.claude/settings.json`, `.mcp.json` (repo root), `.claude/skills`, `.claude/commands` | `.claude/settings.local.json` — auto-gitignored by Claude when it creates the file |
| **opencode** | `~/.config/opencode/opencode.json`, `~/.config/opencode/plugins/` | `opencode.json` (repo root), `.opencode/plugins/` | none (only `OPENCODE_CONFIG` / inline overrides) |
| **Codex** | `~/.codex/config.toml`, `~/.codex/hooks.json` | `.codex/config.toml`, `.codex/hooks.json` (trust-gated) | none (the extra layer is a managed/system layer *above* project, not a personal one below) |
| **Gemini CLI** | `~/.gemini/settings.json` | `.gemini/settings.json`, `.gemini/.env` | `.gemini/.env` (de-facto; we would have to gitignore it ourselves) |

The asymmetry that matters: only Claude Code has a real personal-local scope — `settings.local.json`, which it auto-gitignores when it creates the file. opencode and Codex have no personal-local tier at all; their extra layer is a managed/system layer that sits *above* project scope (org-enforced — the opposite of personal). Gemini's only practical personal knob is `.gemini/.env`, which we would have to gitignore ourselves. So "write the per-user bit into the harness's own local file" is not a portable strategy — it only works on Claude.

The lever we do have, that the harnesses don't, is that `.me/config.local.yaml` is our file. We control its schema, its discovery, and its gitignoring on all four harnesses. That makes it the natural, portable home for the per-user agent identity — and for a private tree, for anyone who doesn't want to share their transcripts — independent of whatever scope model each harness happens to have.

## Wiring the Sentinel

For every harness, the integration we write hardcodes the `.me` sentinel in two places:

- **MCP and hooks** carry `--as-agent .me` in the command we author. The MCP server and every hook therefore run as the agent or die.
- **The tool shell** gets `ME_AS_AGENT=.me` set in the harness's environment, so any `me` the agent shells out to also runs as the agent or dies.

Concretely, per harness:

| Harness | `--as-agent .me` on MCP | `--as-agent .me` on hooks | `ME_AS_AGENT=.me` in the tool shell |
|---|---|---|---|
| **Claude Code** | `.mcp.json` `args` | `.claude/settings.json` hook `command` | `.claude/settings.json` `env` |
| **opencode** | `opencode.json` `mcp.me.command` | `.opencode/plugins/*.ts` (the command it shells out) | the plugin's `shell.env` hook |
| **Codex** | `.codex/config.toml` `[mcp_servers.me].args` | `.codex/hooks.json` `command` | `.codex/config.toml` `[shell_environment_policy].set` |
| **Gemini CLI** | `.gemini/settings.json` `mcpServers.me.args` | `.gemini/settings.json` hook `command` | `.gemini/.env` |

Both are the same static literal — `.me` — so none of this needs variable interpolation, it is identical for every user and every clone, and it names no one. The sentinel means only "resolve the agent from `.me` config, and fail if there isn't one." That is the "run as an agent or die" state we want for situations 1–3. The human's own shell (situation 5) never sets `ME_AS_AGENT`, so a plain `me` in a terminal stays the human.

We standardize the per-user settings — first and foremost the agent name/id — in `.me/config.local.yaml`. It is our file, it is gitignored, and the `.me` sentinel resolves through it on every harness. Nothing about the agent lives in a harness config or a committed file.

## Finding the Right `.me/config.local.yaml`

Activation is solved by the sentinels above. The one hard part left is discovery: when `me` runs, how does it locate the `.me/config.local.yaml` that holds the agent for *this* project?

For the MCP server and the hooks this is already free — every harness launches them with the project as their working directory, so `me`'s normal cwd walk-up finds `.me/` with no help.

The hard case is the agent shelling out `me` from some other directory — a `/tmp`, a `$HOME`, a sibling repo. The walk-up starts from the wrong place and either finds nothing (fail closed — safe, but the command doesn't work) or finds a *different* project's `.me/`. We need `me` to be pointed at the right config dir regardless of cwd.

The lever we have is `--config-dir` / `ME_CONFIG_DIR`, which points `me` at a directory containing `.me/` and skips the walk-up entirely. But baking it in has three problems:

1. The value is a fully-qualified path, so it can't be checked in. And it isn't even per-machine — it's *per-project-directory*: the same repo checked out to N directories has N different absolute paths, so one person can need several distinct values on a single machine.
2. It has to be set at the project scope, not the user scope. A user-scope `ME_CONFIG_DIR` would pin *every* project at one config dir.
3. For opencode the hooks live in a `.ts` plugin, so a hardcoded path lands in the plugin source itself — making the plugin per-checkout, which means it has to be generated at the user scope and left uncommitted.

Put together, we need a per-checkout, project-scoped, uncommitted place to hold an absolute path — and, per the scopes table above, only Claude Code has a native slot for exactly that.

### Claude Code

Claude has that slot: `.claude/settings.local.json`, which it auto-gitignores. Each user's setup, run once per checkout, writes the absolute path into its `env` block:

```json
{ "env": { "ME_CONFIG_DIR": "/abs/path/to/this/checkout" } }
```

Claude applies settings `env` to every session and to the subprocesses it spawns, so the Bash tool inherits `ME_CONFIG_DIR` and an ad-hoc `me` from any cwd resolves the right `.me/config.local.yaml`. The value is a literal — no interpolation needed (the `env` block doesn't support it anyway), which is fine because it's written locally, per checkout, at setup time.

This also pins identity to the *session's* project rather than to wherever the agent happens to `cd`: if the agent wanders into a sibling repo and runs `me`, it still acts as this session's agent — which is what we want, and what a bare walk-up would get wrong.

One thing to verify empirically: that the settings `env` block actually reaches the interactive Bash-tool shell. The docs' "subprocesses" language covers it, but it wasn't proven (the same docs rate `env`→MCP-server propagation only medium-confidence).

### opencode

opencode has no local scope, but it doesn't need one: its hooks are a TypeScript plugin, and a plugin is *code*. The plugin closure is handed the project paths at runtime — `directory` and `worktree` — so it can compute the config dir itself instead of storing one.

The plugin lives at project scope (`.opencode/plugins/memory-engine.ts`) and is committable, because it holds no absolute path and no identity — only logic. Its `shell.env` hook sets both sentinels for every tool shell, at runtime:

```ts
export const MemoryEngine = async ({ worktree, directory }) => ({
  "shell.env": async (input, output) => {
    output.env.ME_AS_AGENT = ".me"                    // activate
    output.env.ME_CONFIG_DIR = worktree ?? directory  // discover (computed, not stored)
  },
  // …capture hooks…
})
```

So an ad-hoc `me` from any cwd both activates and finds the right `.me/config.local.yaml`, with nothing hardcoded and nothing per-checkout. The same `worktree` is passed to the capture hook the plugin shells out (`me --as-agent .me --config-dir <worktree> opencode hook …`), and the MCP entry in `opencode.json` carries `--as-agent .me` (discovery there is free — opencode launches the MCP server with the project as its cwd).

This *dissolves* the three problems rather than solving them: the value is computed, not stored, so (1) there is no absolute path to check in, (2) it is project-scoped by construction, and (3) the plugin needn't be a user-scope, uncommitted file — it can be committed, because it is person-less.

Two caveats:

- Whether `shell.env` reaches the MCP server's own process env is undocumented — but the MCP server doesn't need it (cwd = project), so it doesn't matter.
- `shell.env` injects into user terminals too, so a human running `me` in opencode's built-in terminal inside a set-up project acts as the agent. That's the same "built-in terminal" wrinkle we accept elsewhere; the human's *own* terminal, outside opencode, is untouched.

#### User-scope vs. project-scope

The plugin doesn't have to live in the project. It can just as well be installed once per machine at the user scope (`~/.config/opencode/plugins/`, which is where our current template already targets), and it still works — but the two axes behave differently.

**Discovery is unchanged.** The closure's `worktree`/`directory` are resolved per session at runtime, so a user-scope plugin computes the correct config dir for whatever project each session is in. Discovery doesn't care about the plugin's install scope.

**Activation is the catch.** A project-scope plugin is naturally scoped — it only exists in set-up projects, so `ME_AS_AGENT=.me` is only injected where an agent is expected. A user-scope plugin runs for *every* opencode session in *every* project, so a blanket `ME_AS_AGENT=.me` would force "agent-or-die" onto projects that never opted in, and any `me` there would fail closed. To install at user scope, the plugin must self-gate on the presence of a `.me/` for the session's project:

```ts
export const MemoryEngine = async ({ worktree, directory }) => ({
  "shell.env": async (input, output) => {
    const root = worktree ?? directory
    if (await exists(join(root, ".me"))) {   // only for me-enabled projects
      output.env.ME_AS_AGENT = ".me"
      output.env.ME_CONFIG_DIR = root
    }
  },
  // …capture hooks…
})
```

Gate on the presence of `.me/`, not on `config.local.yaml` specifically: an enabled project where the user hasn't set up their agent yet should still activate and fail closed (goal 3), not silently fall back to the human. A non-me project has no `.me/`, so the sentinels are never set and `me` stays the human.

Both scopes work; the tradeoff is:

| | Project-scope (`.opencode/plugins/`) | User-scope (`~/.config/opencode/plugins/`) |
|---|---|---|
| Install | committed once, every teammate gets it on clone | each user runs one command per machine |
| Scoping | natural — only in set-up projects | must self-gate on `.me/` presence |
| Committed artifact | a person-less `.ts` in the repo | nothing in the repo |
| Discovery | runtime `worktree` | runtime `worktree` (identical) |
| "Agent-scoped" signal | the plugin being present in the repo | a `.me/` existing for the project |

The user-scope + gate variant fits the "every user runs at least one `me` command per machine, nothing need be checked in" principle best. Note the self-gate trick is only possible because opencode's hook is code — Codex and Gemini can't gate in-config, which is part of why they're harder.

### Codex

Codex is the worst-equipped of the four: `config.toml` does no value interpolation (a `set` entry is injected verbatim), there is no project-dir variable anywhere, there is no personal-local scope, and the config is data, not code — so there's no runtime computation to fall back on.

**Activation is still trivial**, because it only needs static literals:

```toml
# .codex/config.toml
[mcp_servers.me]
command = "me"
args = ["--as-agent", ".me", "mcp"]

[shell_environment_policy]
set = { ME_AS_AGENT = ".me" }
```
```json
// .codex/hooks.json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "me --as-agent .me codex hook --event stop" }] }] } }
```

`ME_AS_AGENT=.me` survives the shell-env filter (the KEY/SECRET/TOKEN exclude is off by default, and it wouldn't match anyway). So "run as an agent or die" is fully enforced on all three surfaces with no interpolation.

**Discovery is where Codex has no good lever.** But look at what actually needs it:

- MCP server — Codex launches it with the session (project) cwd, so walk-up finds `.me/`. Free.
- Hooks — the command runs with the session cwd as its working directory, and the payload carries `cwd` on stdin, so the handler resolves (or passes `--config-dir` itself). Free.
- Ad-hoc `me` in the tool shell — Codex runs tool commands in the session cwd too, so a bare `me` (or one from a project subdir) still walks up to the right `.me/`. The **only** gap is the agent explicitly `cd`-ing out of the project and then running `me` — and that fail-closes safely (the sentinel is set, no `.me/` is found, the command dies rather than running as the user).

So on Codex we **rely on cwd for discovery** and accept that the arbitrary-cwd edge degrades to a safe hard-fail. There is no clean way to bake a portable `ME_CONFIG_DIR`: an absolute path can't be committed (problem 1), user-scope `~/.codex/config.toml` would pin every project (problem 2), and there is no local file to hold a per-checkout value (problem 3, with no runtime-compute escape).

If we ever need to close that edge, the only option is to go fully per-user: each user runs `me codex init`, which generates a **gitignored** `.codex/config.toml` with an absolute `ME_CONFIG_DIR` baked into `set` for that checkout. This trades away committed, shared wiring — but Codex already forces per-user interaction anyway: project `.codex/` loads only when the user **trusts the project**, and each non-managed hook must be **hash-approved** via `/hooks`. So "every teammate runs init and approves" is the Codex baseline regardless; whether the resulting file is committed (option A) or gitignored-per-user (option B) is the only question.

### Gemini CLI

Gemini lands between Codex and opencode. Like Codex it isn't code, so it can't compute a path at runtime — but it has two levers Codex lacks: hook commands can reference `$GEMINI_PROJECT_DIR`, and `.gemini/.env` is a real per-user, gitignore-able file separate from the committed config.

**Activation is static literals again:**

```jsonc
// .gemini/settings.json  (committed, person-less)
{
  "mcpServers": { "me": { "command": "me", "args": ["--as-agent", ".me", "mcp"] } },
  "hooks": { "AfterAgent": [{ "hooks": [{ "type": "command",
    "command": "me --as-agent .me --config-dir \"$GEMINI_PROJECT_DIR\" gemini hook --event after-agent" }] }] }
}
```
```
# .gemini/.env
ME_AS_AGENT=.me
```

`ME_AS_AGENT` isn't in `excludedEnvVars` and isn't a sensitive-name pattern, so it reaches the tool shell (and survives GitHub Actions' forced-strict redaction).

**Discovery is better than Codex on two of the three surfaces:**

- MCP — launched with the project as cwd; walk-up finds `.me/`. Free.
- Hooks — Gemini substitutes `$GEMINI_PROJECT_DIR` (the project cwd) literally into the hook command string, so we pass `--config-dir "$GEMINI_PROJECT_DIR"` and get **explicit**, robust discovery, independent of the handler's cwd. This is the direct project-dir lever Codex doesn't have.
- Ad-hoc `me` in the tool shell — same gap as Codex. `.gemini/.env` is plain `dotenv` (no interpolation), and settings.json's `${VAR}` expansion only substitutes env vars into settings *values* (not tool-shell env), with no project-dir var to reference anyway (`$PWD` = launch cwd, brittle). So a bare `me` resolves via cwd walk-up (tool shell runs at project cwd), and an explicit `cd`-away fail-closes.

**Closing the tool-shell gap is cleaner here than on Codex.** `.gemini/.env` is a per-user, gitignored file *separate* from the committed `settings.json`, so each user's `me gemini init` can write an absolute `ME_CONFIG_DIR=/abs/path/to/checkout` there (gitignored, per-checkout) to close the arbitrary-cwd edge, while `settings.json` keeps carrying the person-less activation + hook config-dir. Codex couldn't split like this — its single `config.toml` forces all-or-nothing; Gemini's env/settings split lets us commit the wiring and localize just the path.

Caveats:

- `.env` load is first-match-only — `.gemini/.env` is preferred over a root `.env`, and only the first found is loaded (not merged) — so keep our vars in `.gemini/.env`.
- If a team blanket-gitignores `.env`, a committed `.gemini/.env` carrying `ME_AS_AGENT=.me` may be excluded; the per-user variant sidesteps that.
- Under GitHub Actions, redaction is force-enabled, but `ME_*` vars aren't sensitive-pattern so they still pass.

Recommended: commit the person-less `settings.json` (MCP + hooks using `$GEMINI_PROJECT_DIR`), and write `ME_AS_AGENT=.me` (optionally with a per-checkout `ME_CONFIG_DIR`) into a per-user `.gemini/.env`. That gives robust discovery on MCP and hooks, and closes the tool-shell edge without committing any path.

## Synthesis

Working through all four harnesses, the same shape holds everywhere:

| Harness | Activation | Discovery — MCP / hooks / ad-hoc shell | Closes the ad-hoc gap? |
|---|---|---|---|
| **Claude Code** | static `.me` — settings `env`, hook command, `.mcp.json` args | cwd / cwd / `ME_CONFIG_DIR` in `settings.local.json` | Yes — real local scope |
| **opencode** | static `.me` — plugin `shell.env`, hook command, `opencode.json` | cwd / cwd / plugin computes `worktree` at runtime | Yes — the hook is code |
| **Codex** | static `.me` — `config.toml`, `hooks.json` | cwd / cwd + stdin `cwd` / cwd only | No — cwd + safe fail-closed edge (or go fully per-user, gitignored) |
| **Gemini CLI** | static `.me` — `settings.json`, `.gemini/.env` | cwd / `$GEMINI_PROJECT_DIR` / cwd only | Partly — a per-user `.gemini/.env` can hold the path |

Three things fall out of this.

**Activation is trivial and portable everywhere.** A static `.me` literal drops into every harness's MCP args, hook command, and tool-shell env with no interpolation. So "make the agent the default" and "make accidentally running as the user hard" (goals 1 and 3) are solved uniformly, on day one, for all four.

**Discovery is the only hard axis — and it never trades against safety.** Every unsolved case fail-closes: the sentinel is set, no `.me/` is found, and the command dies rather than running as the owner. So the differences between harnesses are differences in *convenience* (does the ad-hoc-from-anywhere case just work, or does it hard-fail until you're in the project tree?), never in *safety*. That lets us ship the portable core first and improve discovery per harness later. The harnesses sort by how much runtime/local capability they have to close the ad-hoc gap: opencode (it's code) and Claude (a real local scope) close it cleanly; Gemini closes it for hooks via `$GEMINI_PROJECT_DIR` and can localize a path in `.gemini/.env`; Codex can only lean on cwd and accept the fail-closed edge.

**The MCP server — our main integration point — is the easy case on all four.** Every harness launches it with the project as its working directory, so it activates with `--as-agent .me` and discovers via cwd, with nothing extra. The harder surfaces (ad-hoc shell especially) are the periphery, and they degrade safely.

The through-line from the founding principles holds: the agent identity stays per-user in `.me/config.local.yaml` and is never committed; the harnesses carry only the person-less `.me` sentinel; and the only genuinely hard problem — pointing `me` at the right config when it runs from an odd directory — is bounded, per-harness, and fail-closed.

## User-scope Installs

Nothing above requires the integration to be installed per project. A user-scope install is a first-class option, and it composes with project scope rather than competing with it: **project scope overrides the user default when you're in a project.** That's what lets one install behave three ways — your human identity or a fixed agent outside a project, and the project's agent inside one.

The user layer is a pick-one default, chosen at install time:

- **Human** (default) — bake nothing: a plain `me mcp`, no `ME_AS_AGENT`. Outside a project you run as yourself.
- **A fixed agent** — bake a *literal* agent id: `--as-agent <id>` in the MCP command and `ME_AS_AGENT=<id>` in the tool-shell env. This resolves verbatim (the non-`.me` branch of `resolveAsAgent`), needs no `.me` config, and gives you a stable "scratch" agent for non-project work.

The project layer, when present, supplies the `.me` sentinel and **shadows** whichever user default you chose:

| Context | Human user default | Fixed-agent user default |
|---|---|---|
| **non-project dir** | runs as you | runs as the fixed agent |
| **`.me` project dir** | project agent (`.me`) | project agent (`.me`) |

The override falls out of ordinary precedence on every surface: MCP entries are keyed by name, so the project `me` entry shadows the user one; tool-shell env merges project-over-user (and Gemini's `.env` walk-up finds `.gemini/.env` before `~/.gemini/.env`); hook commands are per-scope. So "follow the project when I'm in one, otherwise use my default" is automatic once both layers are installed.

Two honest limits:

- **"Follow the project" needs the project layer to exist.** On Claude, Codex, and Gemini the user-scope MCP/env are static, so a *user-scope-only* install (no project files at all) cannot detect a `.me` and switch to the project agent on its own — it stays on your user default everywhere. Getting project-following there means installing the project layer too (the two-layer model), or accepting *implicit* activation (`me` auto-activating from a `.me` in cwd), which we deliberately keep off to preserve the explicit human/agent line.
- **opencode is the exception** — because its hook is code, a single user-scope self-gating plugin already does the full context-sensitive behavior (human/fixed outside, project agent inside) with no project files. It's the one harness where user-scope-only gives you everything.

So the answer to "can I install to user scope and still get project-specific behavior in projects?" is **yes** — via the user default + project override layering — with the one caveat that on the three non-code harnesses the project override must be installed to take effect (it isn't conjured from a user-scope-only install). Capture stays independent of all this: off by default, opt-in, with a single global tree for non-project sessions (see `user-scope-vs-project-scope.md`).

## Current State — What's Implemented Today

The code that exists today predates this analysis and made a different, reasonable-at-the-time tradeoff: rather than solve cwd-independent discovery for the `.me` sentinel, it writes the resolved agent **name** directly into config. That single decision is the root of the gaps below; most of them are consequences of it, not independent problems. Importantly, the resolution machinery this proposal needs already exists and is sound — the gaps are almost entirely on the **write/install side**.

Where the current implementation and this proposal diverge:

1. **The `.me` sentinel is present but unused in practice.** `resolveAsAgent()` fully supports `.me` (`credentials.ts`), but no install/init flow ever writes `.me` into a harness surface. `me project init` writes the *literal* agent name, so the sentinel only resolves when a human types `--as-agent .me` by hand. The indirection exists; nothing routes through it.

2. **The agent name is written into committed files.** `me project init` writes the literal name into both committed `.me/config.yaml` (`agent:`) and committed `.claude/settings.json` (`ME_AS_AGENT`). Because act-as-agent resolves only against the caller's own agents, a teammate who clones inherits an un-ownable name (the TNT-182 403). This proposal moves identity to per-user `.me/config.local.yaml` and keeps only the person-less sentinel in shared files.

3. **`.me/config.local.yaml` is read but never written, and not gitignored.** Discovery merges it (committed + local, local wins), but no command creates it or writes `agent:` into it, and there is no gitignore-management code in the CLI. The per-user identity file this proposal centers on has no writer yet.

4. **Activation isn't fail-closed at the integration surfaces.** The MCP command (`buildMeCommand`) and the committed `.mcp.json`, `hooks.json`, and opencode plugin template carry no `--as-agent .me`. Agent identity arrives ambiently — via the `ME_AS_AGENT` env baked into committed `settings.json`, or a baked `--api-key` — so nothing "runs as the agent or dies." The MCP server itself runs as the human (login session) or a headless key, never act-as-agent.

5. **`ME_CONFIG_DIR` / `--config-dir` is never persisted.** It's read (with no-walk-up semantics) but no install/init flow writes it; hooks discover via cwd (Claude from the event `cwd`, opencode from `process.cwd()`). The arbitrary-cwd case is unsolved — which is exactly why the current code baked in the literal name instead of using the sentinel.

6. **Two of four harnesses are MCP-install-only.** Claude and opencode have full MCP + hooks + capture. Codex and Gemini have MCP registration only — no hooks, no capture, and no tool-shell env writer to set `ME_AS_AGENT` (Codex `shell_environment_policy` / Gemini `.gemini/.env`). Their MCP command also carries no agent.

**What already aligns (the reusable core):** the `.me` sentinel resolver and its explicit-activation semantics, `config.local.yaml` discovery/merge with per-field override, `--config-dir` / `ME_CONFIG_DIR` read with no-walk-up, the client-side unresolved-`.me` guard, and end-to-end `asAgent` plumbing into capture / MCP / serve. Realigning to this proposal is mostly a matter of changing what `init`/install **write** (sentinel + local identity + `ME_CONFIG_DIR` + gitignore), adding the fail-closed guard, and building out Codex/Gemini hooks and env writers — not re-architecting resolution.


## Appendix - Coding Harness Popularity & Usage

*Snapshot date: 2026-07-06. All figures pulled live from public APIs (GitHub REST API, npm registry downloads API, PyPI/pypistats).*

### TL;DR

- There is **no single authoritative breakdown** of "% of coding-harness users per tool." The market is young, most vendors don't publish comparable active-user numbers, and available signals measure different things (installs vs. stars vs. survey self-reports vs. token traffic).
- The **best public proxy for real usage is package downloads**. GitHub stars measure mindshare/bookmarking, not use, and frequently invert the download ranking.
- On downloads, the field today falls into tiers:

  **Claude Code ≈ Codex (~10M/wk, first-party, dominant) >> opencode ≈ Pi (~1.7–1.9M/wk) >> Gemini CLI (~0.4M) > Aider (~0.2M)**, with Goose and the VS Code–extension tools (Cline / Roo / Continue) measured on separate scales.

### 1. GitHub stars (mindshare proxy — NOT usage)

| Harness | Repo | Stars | Forks |
|---|---|---|---|
| opencode | anomalyco/opencode | 183,046 | — |
| Claude Code | anthropics/claude-code | 136,557 | 21,937 |
| Gemini CLI | google-gemini/gemini-cli | 105,813 | 14,229 |
| Codex | openai/codex | 95,888 | 14,233 |
| Pi | earendil-works/pi | 68,145 | — |
| Cline | cline/cline | 64,357 | 6,854 |
| Goose | aaif-goose/goose | 50,735 | — |
| Aider | Aider-AI/aider | 47,128 | 4,706 |
| Continue | continuedev/continue | 34,725 | 4,977 |
| Roo Code | RooCodeInc/Roo-Code | 24,309 | 3,353 |

### 2. Package downloads (best usage proxy)

Weekly window: 2026-06-29 → 2026-07-05.

| Harness | Package | Downloads / week | Downloads / month |
|---|---|---|---|
| Claude Code | `@anthropic-ai/claude-code` (npm) | 10,951,819 | — |
| Codex | `@openai/codex` (npm) | 10,395,139 | — |
| opencode | `opencode-ai` (npm) | 1,864,928 | — |
| Pi | `@earendil-works/pi-coding-agent` (npm) | 1,702,315 | 8,459,601 |
| Gemini CLI | `@google/gemini-cli` (npm) | 406,416 | — |
| Aider | `aider-chat` (PyPI) | 206,257 | 853,617 |

Not on npm/PyPI in a comparable way (measured on separate scales):

- **Goose** — Rust binary; distributed via GitHub releases.
- **Cline / Roo Code / Continue** — VS Code extensions; install counts live on each extension's VS Code Marketplace page.

### Analysis & caveats

- **Stars vs. downloads invert.** opencode leads on stars (183k) but Claude Code and Codex lead downloads by ~5–10×. Stars ≈ "people who bookmarked a cool OSS project"; downloads ≈ "machines that actually pulled the tool." Trust downloads for a usage question.
- **Claude Code's repo is mostly a shell** (issues + docs, not source), yet it tops downloads — reinforcing that repo activity/stars are a poor usage proxy for the closed first-party tools.
- **Download counts overcount humans.** CI/CD and Docker rebuilds re-pull on every run, inflating weekly numbers. The noise hits all npm tools similarly, so *relative* ranking holds, but absolute "users" is smaller than downloads imply.
- **Pi punches above its star count.** At ~1.7M/wk it's roughly tied with opencode and ~4× Gemini CLI despite far fewer stars — notable for an ~11-month-old project (repo created 2025-08-09) from a small company (Earendil). Its SDK/RPC/print modes and embed-friendly design (e.g. the OpenClaw integration) likely drive programmatic pulls, so some of that volume is automation rather than interactive human use. Pi also ships a `curl | sh` installer and `npm ... --ignore-scripts`, so some real installs bypass npm entirely — meaning npm may *undercount* it.
- **Gemini CLI looks low on downloads relative to stars** — plausibly because much Gemini coding usage flows through the bundled Cloud/IDE assistant rather than the standalone npm CLI.
- **First-party vs. BYO-key routing** is the single biggest reason no clean unified pie chart exists: closed tools (Claude Code, Codex, Gemini) are invisible to router-based leaderboards, while OSS tools are overrepresented on stars.

### Better sources for a true "% of users" split

- **Stack Overflow Developer Survey** and **JetBrains State of Developer Ecosystem** — self-reported usage (closest to "% of users"), but their tool lists lag the fast-moving harness space and rarely break out agentic CLIs individually.
- **Vendor-reported figures** (Anthropic / OpenAI / Google) exist but use non-comparable units (revenue run-rate, growth %) rather than MAU.
