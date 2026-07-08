# Config-First Harness Integration (Alternate Design)

Alternate design to
[`proposal.md`](https://github.com/timescale/memory-engine/blob/9acf9f2549b8fcba4c5765bafb3bdb18b1e4c39b/proposal.md)
(the sentinel-wiring design).

## Background

The prior design achieves "run as an agent or die" by writing wiring into each
harness's own config surfaces, per project: `--as-agent .me` baked into the MCP
args and hook commands in committed harness files (`.mcp.json`,
`.claude/settings.json`, `opencode.json`, `.codex/config.toml`,
`.gemini/settings.json`), plus `ME_AS_AGENT=.me` in each harness's tool-shell
env mechanism.

The downside is structural: we must create and maintain special files in every
project, per harness. Four harnesses × N projects × (MCP + hooks + env) is a
lot of generated surface area, and it drifts — a teammate's checkout, an
upgraded template, a hand-edited settings file, and a stale `.mcp.json` can all
disagree with each other and with what `me` expects. The harness files become a
second, denormalized copy of what the `.me` config already knows.

This design inverts the dependency: the `.me` config is the single source of
truth, and `me`'s own code paths (MCP server, hook handlers, CLI) decide how to
authenticate by reading it. Harness-side files carry as little as possible —
ideally nothing project-specific at all.

That inversion buys two concrete advantages:

1. **No per-harness config in the project dir.** The project carries only
   `.me/` — no generated `.mcp.json`, `.claude/settings.json`,
   `opencode.json`, `.codex/config.toml`, or `.gemini/settings.json` to
   create, keep in sync, or drift. Harness integrations are installed once
   per machine, at user scope.
2. **A checkout works without special post-checkout setup.** Everything
   per-checkout is computed at runtime (the injection derives the project
   dir from the live session; activation derives from the config's content),
   so a fresh clone or a new git worktree needs no generated files. The
   prior design needed per-checkout artifacts — an absolute `ME_CONFIG_DIR`
   baked into `.claude/settings.local.json`, a gitignored per-user
   `.codex/config.toml` — that had to be regenerated for every checkout of
   every project.

## Goals

1. **Agent-by-config.** If a harness (Claude Code, Codex, Gemini CLI,
   opencode) runs in a directory that contains a `.me` config with an agent
   defined, it uses that agent for its work. "Its work" means all three
   integration surfaces:
   - (a) MCP tool calls (the `me mcp` server),
   - (b) hooks — capture of session transcripts and git commits,
   - (c) any `me` CLI invocation the harness makes from its shell tool.

2. **Human stays human.** If a user runs the `me` CLI in that same directory,
   it runs as the user (their own credentials), unless `--as-agent` is passed
   explicitly.

3. **No fallback.** A harness never falls back to the user's credentials when
   the `.me` config specifies an agent. Every harness surface either acts as
   the configured agent or fails closed.

### Corollaries and boundaries

- Goals 1(c) and 2 together mean the same binary, in the same directory, with
  the same config must behave differently depending on *who invoked it*. The
  discriminator cannot come from the config or the filesystem; it must come
  from the invoking environment (something the harness sets that a human
  terminal does not).
- Goal 3 makes goal 1 safety-relevant, not just convenience: when the agent
  cannot be resolved (or the invoking context cannot be trusted to be the
  harness), the correct degradation for a harness surface is a hard failure,
  never the user's credentials.
- When no agent is in scope — the `.me` config defines none (or doesn't
  exist) and the global `~/.config/me/config.yaml` defines no fallback
  `agent:` — the *shared* surface stays lenient: a plain `me` (human, or an
  agent under a live integration) runs as the user. The **harness-only**
  surfaces do not: `me mcp` fails with an actionable error and capture
  hooks skip, because MCP and hook work is agent work by definition — no
  human ever invokes them — so serving them as the user is exactly the
  silent fallback goal 3 exists to prevent. Two things keep that strictness
  low-friction: every install flow provisions a **default agent** and
  writes it as the global fallback (so "no agent anywhere" is rare by
  construction), and the explicit opt-out **`agent: .user`** (a reserved
  sentinel, valid wherever `agent:` is) deliberately selects user-mode
  harness surfaces — converting the forbidden *silent* fallback into a
  visible choice. A global `agent:` never affects the human's own terminal:
  config only supplies the *value*; activation always comes from the
  surface or the injected env.

## Premise: where each surface learns the project directory

The design rests on a claim: surfaces (a) MCP and (b) hooks receive the
project directory directly from the harness, so `me`'s own code can find the
right `.me` config and enforce the goals; only surface (c) — the harness
shelling out to `me` — can run from a directory that breaks discovery.

Verified 2026-07-08 against official docs, harness source, and issue trackers.
**The claim holds**, with per-harness caveats worth designing around. Hooks
are the strongest surface everywhere. MCP is reliable with two exceptions
(Codex in IDE/desktop hosts, a Claude desktop bug). And the shell gap is
*narrower* than assumed: every harness defaults shell commands to the project
directory, so plain cwd walk-up already works in the common case — the real
gap is per-command excursions (`cd /tmp && me …`, an explicit `workdir`), plus
the fact that no harness injects a project-root env var into shell
subprocesses.

### Enforcement by surface

The mechanism, sketched surface-by-surface (per-harness specifics in the
next section):

- **(a) MCP — agent-by-config; no signal needed.** An MCP invocation is
  harness work by definition, so `me mcp` applies the agent unconditionally:
  it resolves the project config — `ME_CONFIG_DIR` if set, else a validated
  harness project-dir env var (today that's Claude's `CLAUDE_PROJECT_DIR`),
  else cwd walk-up (the launch dir itself needn't contain `.me/`; walking up
  to a parent is the normal path) — and if the config in scope defines an
  agent, every request runs as that agent. The `agent:` follows standard
  per-field precedence, so with no project config at all it may come from
  the global `~/.config/me/config.yaml` — a harness session outside any
  project then still runs as the user's designated agent. Config only
  supplies the *value*, never activation, so a global `agent:` leaves the
  human's own terminal untouched (goal 2). A failure to resolve a
  configured agent is fatal (goal 3); it never falls back to the user. **No
  agent in scope anywhere is also fatal** — MCP has no human caller, so
  serving as the user is never right by accident; the error is actionable
  ("create an agent: rerun `me <harness> install`"). The explicit opt-out
  is `agent: .user` in project or global config — a deliberate, visible
  selection of user-credential operation. Install-time default-agent
  provisioning (see plan) makes the fatal path rare in practice.

- **(b) Capture hooks — agent-by-config + explicit `--config-dir`.** Hook
  handlers are likewise our own code invoked by the harness, so they always
  use the configured agent, exactly like MCP: if the config defines an
  agent, capture writes happen as that agent (attribution comes with it).
  Discovery is explicit rather than inferred:
  each integration passes `--config-dir <project dir>` sourced from what the
  harness hands it (Claude: payload `cwd`; opencode: the plugin's
  `worktree`; Codex: payload `cwd`; Gemini: `$GEMINI_PROJECT_DIR`). Capture
  stays best-effort — a hook must never break the session — but it fails
  toward *not capturing*: if the config defines an agent and the agent can't
  be resolved, the hook skips; it never captures as the user. The same rule
  covers the no-agent case: with no agent in scope and no explicit
  `agent: .user` opt-out, the hook skips rather than capturing as the user
  (`me doctor` flags it).

- **(c) Shell — injected env, with a fail-closed detection failsafe.** The
  harness integration injects two variables into every shell command:
  `ME_CONFIG_DIR=<project dir>` (discovery) and `ME_AS_AGENT=.me`
  (activation — resolve the agent from that config or die). A human's own
  terminal has neither, so a plain `me` there stays the human (goal 2). The
  failsafe covers the integration not being live (untrusted Codex hooks,
  uninstalled plugin, an un-integrated harness): if the injection's liveness
  marker is **not** present but `me` detects it is being run by an agent
  (detect-agent plus our extra env-var checks), it **errors** — it does not
  guess an identity or a config. **Decided: the failsafe is unconditional on
  detection** — an agent-run `me` without live injection errors everywhere,
  even with no `.me` config in scope, with an actionable "run
  `me <harness> install`" message. Exemptions: an explicit
  `--as-agent`/`ME_AS_AGENT` (any value), an agent `ME_API_KEY` (the
  sanctioned sandbox mode — the bearer already *is* the agent), the harness
  surfaces themselves (`me mcp`, `me <harness> hook` — they enforce the
  stronger agent-by-config rule and may run without shell injection, e.g. an
  MCP server env carries `CLAUDECODE=1` but never the injected vars), and a
  small diagnostic/setup allowlist (`doctor`, `help`, `--version`, the
  install flows; exact list settled in implementation).

### Enforcement by harness

How we make the goals hold on each surface. All surfaces share one resolution
rule — the project dir comes from, in order:

1. explicit `--config-dir` / `ME_CONFIG_DIR`,
2. a harness-provided project-dir env var, **validated** (accepted only if the
   directory actually contains `.me/`). Validation catches unset or garbage
   values — but **not** the `claude -w` worktree mis-resolution, where the
   main checkout legitimately contains `.me/` too (see the worktree column),
3. cwd walk-up.

The shell surface (c) has two questions the other surfaces never need to
ask. MCP and hook invocations are harness surfaces *by construction* — when
`me mcp` or `me <harness> hook` runs, our code knows a harness is calling and
can apply agent-by-config directly. A plain `me` in the tool shell is just a
process; it must work out two independent facts from its environment:

1. **Where is the governing `.me` config?** (discovery — the config *path*).
   Answered by **injection**: the harness integration injects
   `ME_CONFIG_DIR`, computed per session, into every shell command's env.
   Fallback: cwd walk-up — right in the common case, since every harness
   defaults shell commands to the project dir; injection exists for the
   excursions (`cd /tmp && me …`, an explicit `workdir`, a sibling repo
   reached via `--add-dir`, where walk-up finds nothing or the wrong
   project).

2. **Is a harness invoking me, or the human?** (activation — goals 1(c), 2,
   and 3). Answered by **detection**: `me` looks for evidence of a harness
   in its environment. The primary evidence is the activation signal the
   same injection carries (`ME_AS_AGENT=.me`, plus `AI_AGENT=<harness>` per
   the emerging convention). The backstop evidence, for when injection
   silently didn't run (Codex's hook trust-gate, an uninstalled plugin, a
   harness we never integrated with, like Cursor), is the harness's own
   native marker — detect-agent wrapped with our `OPENCODE=1`/`AGENT=1`
   checks. Injected evidence activates agent-by-config (resolve the agent or
   die); native-marker evidence *without* the injection's liveness var is a
   hard error (the failsafe — see the surface sketch above). Detection is
   one-directional: evidence forces agent-or-die, but the absence of all
   evidence proves nothing — `me` then runs as the human (goal 2). The native markers stay the backstop rather
   than the primary because they are undocumented internals (Codex's and
   opencode's are source-verified, not contractual), while the injected
   signal is ours: versioned, uniform, and testable. False positives (a
   human in an IDE terminal carrying `CLAUDECODE=1`) fail toward less
   privilege, never more: agent mode is clamped by the owner's own access.

| Harness | (a) MCP server | (b) capture hooks | (c) shell: config path — how `ME_CONFIG_DIR` gets injected | (c) shell: harness detection — native backstop marker | Worktree sessions: worktree or original dir? |
|---|---|---|---|---|---|
| **Claude Code** | `CLAUDE_PROJECT_DIR` (set in the server's env), validated; fallback cwd walk-up | payload `cwd` walk-up (worktree-correct; what the hook code does today); `CLAUDE_PROJECT_DIR` (validated) as fallback | SessionStart hook writes `ME_CONFIG_DIR` + activation to `$CLAUDE_ENV_FILE` (sourced before each Bash command); computed from payload `cwd`, not `CLAUDE_PROJECT_DIR` | `CLAUDECODE=1` (documented; also set in IDE terminals) | Plain launch inside a worktree: **worktree** on all signals. Under `claude -w`: `CLAUDE_PROJECT_DIR` = the **original** repo root ([#27343](https://github.com/anthropics/claude-code/issues/27343)), and validation can't catch it — hence hooks/injection prefer payload `cwd` (**worktree**); the MCP spawn cwd under `-w` is unverified, so MCP may resolve the **original** |
| **opencode** | cwd walk-up (server spawns at project dir) | plugin passes its `worktree`/`directory` as `--config-dir` | `shell.env` plugin hook sets `ME_CONFIG_DIR` (+ the activation vars) directly in every shell command's env, computed from `input.cwd`/`worktree` | `OPENCODE=1` / `AGENT=1` (CLI/TUI path); `OPENCODE_CLIENT=desktop` (desktop app) — needs our wrapper; stock detect-agent checks only `OPENCODE_CLIENT` | **Worktree** by construction: the plugin is handed the `worktree` path; MCP and shell children spawn at the instance dir — the checkout the session was opened in |
| **Codex** | cwd walk-up (source-verified: child cwd defaults to the **session cwd** under the CLI; gap only in Desktop/VS Code hosts — env unreachable (`env_clear()`), no MCP `roots`, no pre-spawn hook; per-server `cwd` config is the only fix) | payload `cwd` passed as `--config-dir` (hook runs at session cwd) | PreToolUse rewrite prepends `export ME_CONFIG_DIR=… ME_AS_AGENT=…` to the command | `CODEX_THREAD_ID` (always injected, survives `include_only`) — covers the window where hooks are untrusted | **Worktree**: no stored project-dir signal to go stale — everything derives from the session cwd, i.e. the checkout the session started in (Desktop caveat: cwd not rebound when switching project chats, [#20725](https://github.com/openai/codex/issues/20725)) |
| **Gemini CLI** | cwd walk-up (server spawns at launch dir) | `--config-dir "$GEMINI_PROJECT_DIR"` substituted into the hook command | BeforeTool hook rewrites `run_shell_command`'s `tool_input`, prepending `export ME_CONFIG_DIR=… ME_AS_AGENT=…` to the command | `GEMINI_CLI=1` (documented) | **Worktree**: `GEMINI_PROJECT_DIR` is literally the session cwd (no git-root resolution), so every surface follows the launch dir |

Getting the *worktree* is the right answer for discovery, but it has a
consequence: the committed `.me/config.yaml` travels with the worktree (it's
tracked), while the per-user `.me/config.local.yaml` does not (gitignored →
absent in a fresh worktree). A worktree session therefore sees the project's
committed config but **loses the user's local overlay** — including the
agent identity if it lives only there (open issue 4 below). Whether `me`
should fall back to the main checkout's local file is a mechanism-design
question.

One asymmetry worth naming: **Codex MCP in IDE/desktop hosts** is the only
surface where no signal reaches us at all. It degrades to "runs as the user",
which is goal-3-relevant only when the config defines an agent — the
doctor/install flow should check for exactly this condition. Every shell
surface, by contrast, has both an injection channel (config path +
activation signal) and a native-marker detection backstop — provided our
detection wrapper adds opencode's `OPENCODE=1` / `AGENT=1` itself (stock
detect-agent misses the opencode terminal path).

### Findings by harness

| Harness | MCP server cwd | Hooks: project dir | Shell tool cwd | Native marker in shell env | Dynamic env-injection channel |
|---|---|---|---|---|---|
| **Claude Code** | launch dir in practice (undocumented — the `.mcp.json` `cwd` field is ignored, [#17565](https://github.com/anthropics/claude-code/issues/17565); desktop-Linux bug spawns at `$HOME`, [#75266](https://github.com/anthropics/claude-code/issues/75266)). Docs' sanctioned answer: `CLAUDE_PROJECT_DIR` is set **in the stdio MCP server's env** ([mcp docs](https://code.claude.com/docs/en/mcp)) | stdin payload `cwd` + `CLAUDE_PROJECT_DIR` in hook env; runs at session cwd ([hooks docs](https://code.claude.com/docs/en/hooks)) | persists across calls but **fenced**: `cd` outside project/added dirs → auto-reset to project dir ([tools ref](https://code.claude.com/docs/en/tools-reference)); a single `cd /tmp && …` compound still runs in `/tmp`. No project-root var in Bash env (empirically confirmed absent) | `CLAUDECODE=1` (Bash, hooks, stdio MCP, IDE terminals — [env-vars](https://code.claude.com/docs/en/env-vars)) | SessionStart (also Setup/CwdChanged) hooks write exports to `$CLAUDE_ENV_FILE`, sourced before **each** Bash command |
| **opencode** | project dir (source-verified: `cwd = mcp.cwd ?? instance directory`, [mcp/index.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/mcp/index.ts)); also advertises MCP `roots` | plugin closure gets `directory` + `worktree`; `shell.env` hook gets `input.cwd` ([plugins docs](https://opencode.ai/docs/plugins/)) | fresh process per command, defaults to project dir; out-of-project `workdir` triggers the permission flow; no durable drift possible ([tool/shell.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/shell.ts)) | `OPENCODE=1` + `AGENT=1` + `OPENCODE_PID`, set into opencode's own env by the CLI middleware and inherited by every child via `...process.env` (source-verified). `OPENCODE_CLIENT` is read-side on the CLI path (defaults to `"cli"` at read time) but **is** set by the desktop app (`desktop` — whose children *lack* `OPENCODE=1`) and ACP mode (`acp`); the built-in terminal is hard-marked `OPENCODE_TERMINAL=1` | `shell.env` plugin hook mutates the env of every shell execution |
| **Codex** | defaults to the **session cwd** — the project dir under the terminal CLI (source-verified: `local_stdio_fallback_cwd()` → `session_configuration.cwd()`, `codex-rs` `session.rs`; corroborated by the compatibility table in [#9989](https://github.com/openai/codex/issues/9989)). Desktop/VS Code hosts have open bugs where the workspace cwd isn't applied ([#16390](https://github.com/openai/codex/issues/16390), [#9989](https://github.com/openai/codex/issues/9989)); per-server `cwd` option exists; spawns with `env_clear()` — **inherits no env**; client advertises **no MCP `roots`** | hook commands "run with the session `cwd`"; stdin payload carries `cwd` ([hooks docs](https://developers.openai.com/codex/hooks)) | `workdir` param "defaults to the turn cwd" (session root); model may pass `workdir`/`cd` anywhere. `[shell_environment_policy].set` is static literals; default filter strips env names containing KEY/SECRET/TOKEN | `CODEX_THREAD_ID` (always), `CODEX_CI=1` (unified exec), `CODEX_SANDBOX` (macOS seatbelt only) | PreToolUse hook may rewrite the command (`permissionDecision: "allow"` + `updatedInput`); hooks are trust-gated per definition hash |
| **Gemini CLI** | launch dir (source-verified, [mcp-client.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/mcp-client.ts)); `cwd` option exists; `GEMINI_CLI=1` injected into MCP env | hook cwd = session cwd; `GEMINI_PROJECT_DIR` (= session cwd, *not* a walked-up git root) in hook env **and** substituted into hook command strings; payload carries `cwd` ([hooks ref](https://geminicli.com/docs/hooks/reference/)) | defaults to the target (launch) dir; `dir_path` param is **workspace-gated** ("Path not in workspace"); in-command `cd /tmp && …` still possible | `GEMINI_CLI=1` ([shell docs](https://geminicli.com/docs/tools/shell/)) | BeforeTool hook rewrites `hookSpecificOutput.tool_input` (shallow-merged over the model's args) |

### Surface (a): MCP — confirmed, two caveats

On opencode and Gemini the server's cwd is the project/launch dir
(source-verified). On Claude Code the CLI behaves that way in practice, but
the documented contract is different — Claude sets `CLAUDE_PROJECT_DIR` in the
MCP server's *environment* precisely so servers don't depend on cwd. On Codex
the child's cwd defaults to the **session cwd** — the project dir — under the
terminal CLI (source-verified in `codex-rs`), but the Desktop/VS Code hosts
have open bugs where the workspace cwd isn't applied, and no other channel can
reach the server: `env_clear()` blocks env, the client advertises no MCP
`roots`, and **no hook fires before the spawn** — MCP servers start spawning
inside `Session::new`, while `SessionStart` (the earliest hook) is queued
after that and runs at the start of the first turn. A hook-based handoff was
considered and rejected: `SessionStart` is guaranteed to finish before the
first MCP *tool call*, so a breadcrumb file plus lazy resolution is possible
in principle — but the server has no key to match the right session (cleared
env, no session id in the protocol), and in exactly the broken hosts the
hook's own cwd is wrong too. The IDE-host gap is closable only upstream or by
a per-server `cwd` in Codex config.

What the broken hosts actually do (issue states checked 2026-07-08): the VS
Code extension spawns the server with the extension host's cwd — the VS Code
installation dir ([#9989](https://github.com/openai/codex/issues/9989), open);
Codex Desktop spawns it at `/`
([#16390](https://github.com/openai/codex/issues/16390), open; the related
relative-`cwd` bug [#14449](https://github.com/openai/codex/issues/14449) was
closed as a duplicate), and doesn't rebind cwd when switching project chats
([#20725](https://github.com/openai/codex/issues/20725), open). Both values
make the walk-up find **no** `.me/` (rather than a wrong one), so `me mcp`
falls back to global config — user credentials, active space, no project
agent: the goal-3-relevant degradation the enforcement section flags.

Design consequences: `me mcp` should resolve the project as
`ME_CONFIG_DIR` → `CLAUDE_PROJECT_DIR` (when set, validated) → cwd walk-up.
That is correct on three harnesses in all hosts and on Codex in the terminal;
Codex IDE hosts remain a known gap (mitigable only by a per-server `cwd` in
Codex config, or upstream fix). Caveat: `CLAUDE_PROJECT_DIR` resolves to the
main repo root, not the worktree, under `claude -w`
([#27343](https://github.com/anthropics/claude-code/issues/27343)) — and
`.me/`-existence validation can't catch that case, since the main checkout
contains `.me/` too. Walk-up from cwd doesn't have the bug, which is why the
hook and injection paths prefer the payload `cwd`; for MCP there is no
per-event cwd to prefer, so `-w` sessions may resolve the original checkout
(see the worktree column in the enforcement table).

### Surface (b): hooks — confirmed everywhere, the strongest surface

All four harnesses hand hooks the project directory: Claude and Codex and
Gemini all put `cwd` in the stdin payload (session cwd; walk-up normalizes a
subdir to the `.me` root), Claude/Gemini additionally set a project-dir env
var, and opencode's plugin closure receives `directory`/`worktree` directly.
Our existing Claude hook already does the right thing (payload `cwd` →
`setConfigDirOverride`); the opencode hook currently leans on `process.cwd()`
of the shell-out, which works but should pass the plugin's `directory`
explicitly. Codex and Gemini hooks don't exist yet but have everything they
need.

### Surface (c): the CLI — confirmed tricky, and the gap is precisely bounded

No harness injects a project-root variable into shell subprocesses (verified
empirically for Claude; from source for the rest). But the shape of the gap
matters:

- **Default cwd is the project everywhere.** Claude fences `cd` to the
  project + added dirs and auto-resets; opencode spawns each command at the
  project dir and permission-gates out-of-project workdirs; Codex and Gemini
  default each call to the session root. So a bare `me …` from the agent
  almost always walks up to the right `.me/`.
- **The failure mode is per-command excursions**: `cd /tmp && me …` in one
  compound command (possible on all four), an explicit `workdir`/`dir_path`
  elsewhere (Codex anywhere; opencode with permission; Gemini within the
  workspace), or Claude's `--add-dir` making a *sibling repo* reachable — the
  one case where walk-up finds a **wrong** `.me/` rather than none.
- **Every harness has a code-level injection channel** (last column above)
  that can compute the project dir per session and set env for every shell
  command: `CLAUDE_ENV_FILE`, opencode `shell.env`, Codex PreToolUse rewrite,
  Gemini BeforeTool rewrite. This is what the mechanism below builds on.

### What `me` already provides (verified in-repo)

- Walk-up discovery from `process.cwd()`, memoized per process
  (`packages/cli/project-config.ts:143-156`, `:296-302`); `--config-dir` /
  `ME_CONFIG_DIR` **replaces** the walk-up (no existence check; silently "no
  project config" if no `.me` there).
- `.me/config.yaml` already has an `agent:` field, consumed only as the value
  source for the explicit `.me` sentinel (`--as-agent .me` / `ME_AS_AGENT=.me`
  → `resolveAsAgentFor`, `packages/cli/credentials.ts:606-621`). Nothing
  auto-activates from config presence today.
- The sentinel is already fail-closed: `.me` with no `agent:` in scope throws
  (`credentials.ts:613-618`); the client refuses to send an unresolved `.me`.
- `me mcp` resolves server/space/agent through the same `getProjectConfig()`
  cwd walk-up; `--as-agent` is a global flag it inherits.
- Claude capture hook uses the event payload's `cwd`; opencode hook uses
  `process.cwd()`; **no Codex/Gemini hooks exist yet**.
- If the resolved credential is already an agent api key, an `X-Me-As-Agent`
  header is ignored server-side (agent identity wins) — so injecting
  activation env cannot double-switch a sandboxed `ME_API_KEY` setup.

### Open issues surfaced by verification

1. **The harness/human discriminator has no *single* portable form — but
   every harness has a native one.** Claude sets `CLAUDECODE=1`, Gemini
   `GEMINI_CLI=1`, Codex `CODEX_THREAD_ID`, and — source-verified, correcting
   the agent-env doc — opencode too: its CLI middleware exports `OPENCODE=1`,
   `AGENT=1`, and `OPENCODE_PID` into its own env, which every child (shell
   command, MCP server, terminal) inherits. The desktop app is the variant
   case: it sets `OPENCODE_CLIENT=desktop` instead (its children lack
   `OPENCODE=1`), and the built-in terminal is additionally hard-marked
   `OPENCODE_TERMINAL=1`. So the discriminator is env we inject, with a
   native-marker backstop available on **all four** harnesses.

   [`@vercel/detect-agent`](https://github.com/vercel/vercel/tree/main/packages/detect-agent)
   packages most of this backstop: its matrix checks the generic `AI_AGENT`
   convention first, then per-harness markers — `GEMINI_CLI`,
   `CODEX_SANDBOX`/`CODEX_CI`/`CODEX_THREAD_ID`, `CLAUDECODE`/`CLAUDE_CODE`,
   `OPENCODE_CLIENT`, plus Cursor/Copilot/Devin/Replit/others we have no
   integration for. Caveats: (a) it does **not** check `OPENCODE=1`/`AGENT=1`,
   so stock detect-agent misses terminal-launched opencode — our wrapper adds
   those checks (worth upstreaming); (b) it answers "is some agent upstream",
   not "which is innermost" — fine here, since the backstop only needs the
   binary. Because it checks `AI_AGENT` first, our own injection can set
   `AI_AGENT=<harness>` per the same convention, making the injected and
   native signals converge on one detection path. Over-detection fails in
   the safe direction: agent mode is privilege-*reducing* (the
   `agent_tree_access` clamp), so a false positive acts as the agent or
   fails closed — never escalates.
2. **Injection can silently not run.** Codex hooks are trust-gated per
   definition hash (skipped until approved, re-approval after updates), and
   the agent-env design is deliberately fail-open. A failed injection turns a
   harness `me` call into a user-credential call — a goal-3 violation. The
   mechanism's answer is the failsafe: a detected native marker without the
   injection's `ME_INJECT_V` liveness var is a hard error (see the mechanism
   section).
3. **Human-inside-harness terminals.** IDE integrated terminals set
   `CLAUDECODE=1`, and injected env reaches opencode's built-in terminal — a
   human typing `me` there is indistinguishable from the agent and will act as
   the agent. Accepted wrinkle (same as prior design), but goal 2 should be
   worded as "the human's own terminal". Partial exception: opencode hard-sets
   `OPENCODE_TERMINAL=1` on built-in-terminal children (unoverridable by
   plugins), so there `me` *could* elect to stay human — a policy choice for
   the mechanism design.
4. **Worktrees.** `CLAUDE_PROJECT_DIR` mis-resolves under `claude -w`
   (main root, not worktree), and a gitignored `.me/config.local.yaml` is
   absent in a fresh worktree — if the agent identity lives only in the local
   file, a worktree session silently loses it (and with it, goals 1 and 3).

## Mechanism for (c): the harness-injected environment

An adaptation of the `me/agent-env` bundled-hooks design: thin per-harness
adapters, all policy in the CLI. Each harness's dynamic channel invokes a
`me`-owned subcommand that computes the exports at runtime; the adapter
itself is static and person-less.

**The injected contract** (all names pass Codex's KEY/SECRET/TOKEN filter):

| Variable | When injected | Meaning |
|---|---|---|
| `ME_INJECT_V=<version>` | always (integration live) | liveness + version marker; what the failsafe and `me doctor` key on |
| `AI_AGENT=<harness>` | always | identity, per the detect-agent convention (innermost harness wins) |
| `ME_CONFIG_DIR=<project dir>` | when a `.me/` is in scope for the session | discovery — pins config resolution regardless of cwd |
| `ME_AS_AGENT=.me` | when an agent is in scope (project config, else the global config's fallback `agent:`; `agent: .user` opts out) | activation — resolve the agent from config scope or die |

The tiering is what makes the unconditional failsafe compose with the goals'
boundary: in a **non-me project with the integration installed**,
`ME_INJECT_V` is present but `ME_AS_AGENT` is not, so `me` runs as the human
and the failsafe stays quiet. In a **me-project whose injection silently
didn't run** (untrusted Codex hooks, disabled plugin), detection sees a
marker without `ME_INJECT_V` and errors (goal 3). In a **non-me project
without the integration**, an agent-run `me` also errors — the decided
unconditional posture, with the install hint as the error message.

**Failure directions are deliberately opposite.** Injection is fail-open — a
broken adapter must never break the harness; worst case the vars are absent.
The CLI-side failsafe is fail-closed. The pair is what makes fail-open
injection safe: any silent injection failure lands in the failsafe's error,
never in the user's credentials.

**Constraints carried from verification**: values computed at runtime, never
stored (worktrees, clones, N checkouts); adapters are code on all four
harnesses, so the `.me`-presence / agent-defined gating is computable
everywhere; MCP needs no injection (surface (a) discovers independently, and
Codex MCP couldn't receive env anyway).

## Implementation Plan

Decisions locked before planning: failsafe is **unconditional on detection**;
Codex/Gemini get **injection + agent-by-config MCP now, capture hooks
deferred**; agent identity stays the `agent:` **name** in committed
`.me/config.yaml` (each teammate owns an agent by that name; TNT-182) with
`.me/config.local.yaml` as the per-user override; opencode's built-in
terminal is treated as the agent in v1 (`OPENCODE_TERMINAL` exemption
deferred); harness-only surfaces **require** an agent in scope —
no-agent-anywhere is fatal for `me mcp` and a skip for hooks — offset by
install-time default-agent provisioning, with `agent: .user` as the
explicit user-mode opt-out.

### PR 1 — CLI core: detection, failsafe, agent-by-config

No harness files touched; everything unit/integration-testable.

1. **`packages/cli/harness-detect.ts`** (new): `detectHarness()` wrapping
   `@vercel/detect-agent` plus our extra checks (`OPENCODE=1`, `AGENT=1`,
   `OPENCODE_CLIENT`). Take the dependency; keep the wrapper so signals can
   be added without waiting on upstream.
2. **Resolver upgrade** (`packages/cli/project-config.ts`): project-dir
   order becomes `--config-dir` > `ME_CONFIG_DIR` > **validated**
   `CLAUDE_PROJECT_DIR` (accepted only if the dir contains `.me/`) > cwd
   walk-up. Safe to apply globally: the env var only exists in hook/MCP
   processes.
3. **Agent-by-config for harness surfaces**: a helper in
   `packages/cli/credentials.ts` that, for surface commands (`me mcp`,
   `me <harness> hook`), activates the configured agent as if
   `--as-agent .me` were passed (reusing `resolveAsAgentFor`).
   "Resolution failure" means any failure to turn the configured `agent:`
   into a working identity: a malformed config (`ProjectConfigError`), or —
   since the server resolves the name against the caller's **own** agents —
   a name the caller doesn't own or that matches ambiguously (403
   `INVALID_AGENT`; the canonical case is a teammate who cloned a repo whose
   committed config names `coder` but hasn't created *their* `coder` agent
   yet). Behavior: `me mcp` validates **eagerly at startup** with one
   act-as-agent round trip (`whoami`) and exits non-zero with an actionable
   message ("run `me agent create <name>`"), so the harness reports a dead
   MCP server instead of every tool call 403ing; a failure after startup
   (agent deleted mid-session) surfaces as a per-request tool error. Hooks:
   the same failures skip capture. In every case the invariant holds: never
   drop the agent header and retry as the user. Discovery itself is not
   where failure lives: a launch dir without `.me/` walks up to parents as
   usual, and no project config at all just falls through to the global
   `agent:`. But **no agent in scope anywhere is also fatal for `me mcp`**
   (and a skip for hooks) unless the config opts out explicitly with
   `agent: .user` — MCP/hook work has no human caller, so user-mode there
   must be a visible choice, never a default.
4. **Global fallback agent + `.user` sentinel + default-agent helper**: add
   `agent:` to the global `~/.config/me/config.yaml` schema; the `.me`
   sentinel resolves the project `agent:` first, else the global one
   (`resolveAsAgentFor`). Harness surfaces outside any project then run as
   the user's designated agent; the human terminal is unaffected (config
   never activates by itself). `agent: .user` is a reserved sentinel value
   (valid in project and global config) meaning "harness surfaces run as
   the user, deliberately" — and agent-name validation must reject
   leading-dot names so sentinels can never collide with a real agent. Add
   a shared `ensureDefaultAgent()` helper (reusing the `provisionNewAgent`
   machinery from `me project init`) that provisions-or-finds the user's
   default agent and writes it as the global `agent:` — wired into each
   `me <harness> install` in PRs 2–5, and named by the `me mcp` fatal error
   and `me doctor` as the one-command fix. Migration: existing installs hit
   the fatal on upgrade until they run it — the error message *is* the
   migration path.
5. **The failsafe** (root `preAction` in `packages/cli/index.ts`): error
   when `detectHarness()` fires ∧ no `ME_INJECT_V` ∧ no explicit
   `--as-agent`/`ME_AS_AGENT` ∧ credential is not an agent api key ∧ command
   not on the surface/diagnostic allowlist (`mcp`, `* hook`, `doctor`,
   `help`, `--version`, install/init flows). Error message names the
   detected harness and the `me <harness> install` fix.
6. Tests: detect wrapper matrix, resolver precedence + validation
   (project > global agent; `.user` opt-out; no-agent-anywhere fatal for
   mcp / skip for hooks), failsafe truth table (incl. agent-key and
   allowlist exemptions), `me mcp` agent-by-config + eager startup
   validation against local Postgres.

### PR 2 — Claude adapter

1. **`me claude env`** (new subcommand): reads the SessionStart payload,
   resolves the project from payload `cwd`, and appends the contract block
   to `$CLAUDE_ENV_FILE` — idempotent block replacement (SessionStart
   refires on resume and `/clear`).
2. **`packages/claude-plugin/hooks/hooks.json`**: add the SessionStart hook
   invoking it. Existing Stop/SessionEnd hooks stay; their handler picks up
   agent-by-config from PR 1.
3. **`me project init`** (`packages/cli/commands/project.ts`): stop writing
   `ME_AS_AGENT` into committed `.claude/settings.json`
   (`writeClaudeSettingsEnv` call removed; add cleanup of the stale managed
   key). Keep writing `agent:` to `.me/config.yaml`. Existing checkouts
   with the old env keep working (explicit `ME_AS_AGENT` is still honored).
4. **Install-time default agent**: `me claude install` runs the shared
   `ensureDefaultAgent()` step (reused by the PR 3–5 installs). Skipped
   when a global `agent:` is already set — including `.user`, a recorded
   choice never re-prompts — or when the credential is an agent api key
   (headless sandbox mode). The prompt (clack select; first option is the
   default):

   ```
   Memory-engine work done by coding harnesses (MCP tools, session capture)
   runs as an agent you own — constrainable and attributable — not as you.

   ? Which agent should harnesses use by default?
   ❯ Create an agent named "coder" (recommended)
     Pick a different agent…
     Always run as me — writes carry your full access (agent: .user)
   ```

   The default name is harness-neutral (`coder`, not `claude`) because the
   global fallback is shared by all harnesses — and since `agent:` holds a
   *name* resolved against the caller's own agents, a second machine's
   install finds the existing `coder` and offers "Use your existing agent
   'coder'" instead of creating one (users with several agents get a
   picker). Creation admits the agent to the active space with the
   standard `write@/` grant (clamped); other spaces are admitted on demand
   — the `me mcp` eager-validation error names the fix command. Every path
   writes the choice into the global config (`agent: <name>` or
   `agent: .user`). Non-interactive installs apply the default and log it;
   `--no-default-agent` opts out.
5. Docs: `docs/project-config.md`, `docs/mcp-integration.md`, CLI reference.

### PR 3 — opencode adapter

1. **`packages/cli/opencode/plugin-template.ts`**: add the `shell.env` hook
   — root = `worktree ?? directory`; cheap `.me/` presence + `agent:` check
   (file read + regex, cached per root); sets the contract vars. Also pass
   `--config-dir <worktree>` on the `me opencode hook` shell-out (today it
   leans on `process.cwd()`).
2. Bump the plugin template version/marker so `me opencode install`
   refreshes existing installs.

### PR 4 — Codex: injection + MCP

1. **`me codex env-hook`** (new): stdin PreToolUse payload → `updatedInput`
   with the `export …; ` prefix prepended (shlex-quoted, prefix-only);
   empty stdout on any internal error (fail-open). Vendor the tested payload
   shape; treat parse mismatch as fail-open.
2. **`me codex install`**: additionally write the user-scope
   `~/.codex/hooks.json` PreToolUse entry. Document the trust/hash-approval
   flow (`/hooks`) and that re-approval follows `me` upgrades — `me doctor`
   is the post-upgrade check. Verify user-scope hook trust semantics during
   implementation.
3. Document the Desktop/VS Code MCP limitation + the per-server `cwd`
   workaround (goal-3 gap; doctor check in PR 6).

### PR 5 — Gemini: injection + MCP

1. **`me gemini env-hook`** (new): stdin BeforeTool payload →
   `hookSpecificOutput.tool_input` with the same prepended exports;
   fail-open on mismatch.
2. **`me gemini install`**: additionally write the user-scope
   `~/.gemini/settings.json` hooks entry (BeforeTool, matcher
   `run_shell_command`). Gating on `.me/` presence keeps non-me projects
   uninjected-but-live (`ME_INJECT_V` still set).

### PR 6 — `me doctor`

Per-harness probes via the non-interactive modes (`claude -p`, `codex exec`,
`opencode run`, `gemini -p`): assert the contract vars are present and
`ME_INJECT_V` matches the CLI version; check the Codex MCP cwd (flag
Desktop/VS Code hosts); check `.me` gitignore state and whether
`config.local.yaml` exists where `agent:` is expected.

### Verification (whole effort)

- `./bun run check` per PR; `./bun run check:full` before merge (local
  Postgres).
- Manual matrix (scripted where possible, checklist in the PR): for each
  harness — MCP call runs as agent; capture attributes to agent
  (Claude/opencode); `cd /tmp && me whoami` from the agent shell acts as
  agent (injection) ; with the adapter disabled, the same call **errors**
  (failsafe); human terminal `me whoami` stays the human; non-me project
  with integration: `me` runs as human, no failsafe error.
- The nested-harness case (Claude → `codex exec`): inner markers win where
  present; at minimum no crash and no user-credential fallback.

### Deferred (tracked, not in this push)

Codex/Gemini capture hooks; the opencode built-in-terminal human exemption
(`OPENCODE_TERMINAL=1`); worktree fallback to the main checkout's
`config.local.yaml`; upstream PRs (detect-agent `OPENCODE`/`AGENT` checks,
Codex MCP roots/workspace-cwd).
- _MCP needs no injection (surface (a) has its own discovery), and on Codex
  it couldn't receive env anyway (`env_clear()`)._
