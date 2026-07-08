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
- **Every harness context requires an agent in scope — or an explicit
  `.user`.** When neither exists (no project `agent:`, no global
  fallback in `~/.config/me/config.yaml`), harness surfaces fail rather
  than fall back: `me mcp` exits with an actionable error, capture hooks
  skip, and a harness-shell `me` call errors (the injected sentinel
  resolves nothing and throws). User-mode harness work must always trace
  to a deliberate `.user` — a human-written `agent: .user` in the global
  config or `.me/config.local.yaml` (never the committed project file —
  see the threat model), or an explicit `--as-agent .user` /
  `ME_AS_AGENT=.user` on the invocation (the human escape hatch) — never
  to an accident. Two things keep the
  strictness low-friction: every install flow provisions a **default
  agent** and writes it as the global fallback, so "no agent anywhere" is
  rare by construction, and the failure messages name the fix. Two
  contexts run as the user without any of this applying: the human's own
  terminal — no harness context at all — and an **interactive terminal
  that merely carries a harness marker** (an IDE integrated terminal,
  where the failsafe's TTY exemption treats an interactive stderr as the
  human). A global `agent:` never affects either, because config only
  supplies the *value* and activation always comes from the surface or
  the injected env.

## Threat model

Everything in this design is **accident prevention, not an adversarial
boundary**. The harness's shell runs as the user's OS account: an agent
(or a prompt-injected one) can unset the injected vars and the native
markers, edit any config file this design reads — committed, `.local`, or
global — pass `--as-agent .user` itself, or simply read the session token
from the OS keychain / `credentials.yaml`. No client-side mechanism can
bind an uncooperative process. What the goals' "never" means, therefore,
is never *by accident*: no silent user-credential fallback, no
wrong-identity default, no invisible mode switch. The visible artifacts —
an explicit flag in the session transcript, a config line in a file, the
failsafe error — are accountability mechanisms, not prevention.

The real enforcement lives server-side and is unchanged by this design:
the `agent_tree_access` clamp bounds an agent to `least(agent, owner)` at
every path regardless of what the client claims, and `authenticatedAs`
records the human credential behind an act-as-agent request. When the
execution environment itself is untrusted, the sanctioned containment is
the sandboxed **agent `ME_API_KEY`** mode: the environment holds only the
agent's own key — no session token, no keychain — so no user credential is
present to escalate to. That is a property of the deployment, not of this
mechanism.

One case deserves a hard client-side gate anyway, because it is
cross-principal rather than self-inflicted: a **committed `agent: .user`**.
A repo author writing `.user` into the tracked `.me/config.yaml` would
silently flip *every cloning teammate's* harness surfaces to their own
full user credentials — removing the clamp for people who never chose
that. This is the same class the trusted-server gate exists for (untrusted
committed input redirecting credentials), and `.user` is the only
committed value that *raises* effective privilege — a committed
`agent: <name>` can at worst 403, since names resolve against the caller's
own agents. So `.user` is honored from the **global config,
`.me/config.local.yaml`, or an explicit flag/env only**; `.user` in the
committed `.me/config.yaml` is a fatal `ProjectConfigError` naming the
allowed locations. (An agent can of course write `.local` itself — see the
cooperative model above; this gate addresses the cross-user blast radius,
not the local agent.)

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
  it resolves the project config through the shared order — explicit
  `ME_CONFIG_DIR`, the `ME_PROJECT_DIR` anchor, cwd walk-up, else a
  validated harness project-dir env var (today that's Claude's
  `CLAUDE_PROJECT_DIR`) as the last-resort backstop (the launch dir itself
  needn't contain `.me/`; walking up to a parent is the normal path) — and if the config in scope defines an
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
  is `agent: .user` in the local (`.me/config.local.yaml`) or global
  config — a deliberate, visible selection of user-credential operation
  (never the committed file — see the threat model). Install-time default-agent
  provisioning (see plan) makes the fatal path rare in practice.

- **(b) Capture hooks — agent-by-config + explicit `--config-dir`.** Hook
  handlers are likewise our own code invoked by the harness, so they always
  use the configured agent, exactly like MCP: if the config defines an
  agent, capture writes happen as that agent (attribution comes with it).
  Discovery is explicit rather than inferred:
  each integration passes the session anchor (`--project-dir`) sourced from
  what the harness hands it (Claude: payload `cwd`; opencode: the plugin's
  `directory`; Codex: payload `cwd`; Gemini: `$GEMINI_PROJECT_DIR`). Capture
  stays best-effort — a hook must never break the session — but it fails
  toward *not capturing*: if the config defines an agent and the agent can't
  be resolved, the hook skips; it never captures as the user. The same rule
  covers the no-agent case: with no agent in scope and no explicit
  `agent: .user` opt-out, the hook skips rather than capturing as the user
  (`me doctor` flags it).

- **(c) Shell — injected env, with a fail-closed detection failsafe.** The
  harness integration injects the contract vars into every shell command:
  `ME_PROJECT_DIR=<session dir>` (the discovery anchor — `me` walks up from
  it at invocation time), `ME_AS_AGENT=.me` (activation — the ordinary
  sentinel, injected ungated), and `ME_INJECT_V`/`AI_AGENT`
  (liveness/identity). The sentinel resolves project → global → `.user`;
  with nothing in scope it hard-throws — so a harness shell is always the
  agent, the explicitly-chosen user, or a loud failure. A human's own
  terminal has none of these vars, so a plain `me` there stays the human
  (goal 2). The
  failsafe covers the integration not being live (untrusted Codex hooks,
  uninstalled plugin, an un-integrated harness): if the injection's liveness
  marker is **not** present but `me` detects it is being run by an agent
  (detect-agent plus our extra env-var checks), it **errors** — it does not
  guess an identity or a config. **Decided: the failsafe is unconditional on
  detection in non-interactive contexts** — an agent-run `me` without live
  injection errors everywhere, even with no `.me` config in scope. The
  error is branched by harness: for an integrated harness it names the fix
  ("run `me <harness> install`" — Codex refines this further by reading
  `~/.codex/hooks.json`: entry present means the hooks are likely awaiting
  trust approval, so the fix is "run `/hooks` inside Codex" — see PR 2);
  for a detected-but-unintegrated harness
  (Cursor, Copilot, …) — where no installer exists — it says so and asks
  the user to file a GitHub issue requesting the integration. Deliberately
  **no workaround recipe**: a static `ME_AS_AGENT=.me` in the harness's
  env would cover activation but not discovery — nothing supplies the
  `ME_PROJECT_DIR` anchor dynamically, so excursions (`cd /tmp && me …`)
  would silently mis-scope to the global config — and we'd rather learn
  the demand and ship a real adapter than normalize a degraded one.
  Exemptions: **an interactive terminal** (stderr is a TTY — a harness
  marker without injection there means a human in an IDE integrated
  terminal, not an agent: run as the user and print a one-line notice;
  harness tool shells never allocate a TTY), an explicit
  `--as-agent`/`ME_AS_AGENT` (any value, including `.user` — the universal
  human override), an agent `ME_API_KEY` (the sanctioned sandbox mode —
  the bearer already *is* the agent), the harness surfaces themselves
  (`me mcp`, `me <harness> hook` — they enforce the stronger
  agent-by-config rule and may run without shell injection, e.g. an MCP
  server env carries `CLAUDECODE=1` but never the injected vars), and a
  small diagnostic/setup allowlist (`doctor`, `help`, `--version`,
  `login`, the install flows; exact list settled in implementation).

### Enforcement by harness

How we make the goals hold on each surface. All surfaces share one resolution
rule — the project dir comes from, in order:

1. explicit `--config-dir` / `ME_CONFIG_DIR` — an **exact** location, no
   walk-up (the power-tool override; unchanged semantics),
2. `--project-dir` / `ME_PROJECT_DIR` — the injected session **anchor**:
   `me` walks up from it to find `.me/`. When present it *defines*
   discovery — it replaces the cwd as the walk-up origin, with no
   fall-through to the sources below (a session launched outside any
   project stays outside it),
3. cwd walk-up,
4. a harness-provided project-dir env var, **validated** (accepted only if
   the directory actually contains `.me/`) — the last-resort backstop,
   consulted only when walk-up finds nothing (in practice: Claude's
   desktop-Linux `$HOME` spawn). It sits below cwd walk-up because under
   `claude -w` it names the main checkout rather than the worktree, and
   validation can't catch that — the main checkout legitimately contains
   `.me/` too (see the worktree column).

**The anchor outranks locality — deliberately.** When a session's shell
wanders into *another* project that has its own `.me/` (a sibling repo via
`--add-dir`, a cloned dependency, a nested checkout), the session anchor
still wins. Two reasons. **Surface coherence**: MCP and the capture hooks
are session-anchored by construction, so a locality-first shell would
split-brain a single session — hooks capturing into the launch project's
space while shell `me` calls write into the visited repo's, under a
possibly different agent. **No config adoption by wandering**: agents step
into directories nobody chose deliberately (cloned dependencies, explored
repos); locality-first would let any repo carrying a committed
`.me/config.yaml` silently switch space/tree/agent for commands run inside
it — or hard-fail on the server trust gate in a way that reads as
breakage. Config adoption happens once, at session start, in the directory
the human opened. Deliberate cross-project operation stays explicit:
`--config-dir` / `ME_CONFIG_DIR`. The same principle applies recursively
to **nested harnesses** (Claude spawning `codex exec`): the inner session
was opened by an *agent*, not the human, so letting its spawn location
pick the config would be config adoption by wandering — instead the
initiating session's contract propagates down the process tree. Adapters
are **first-writer-wins**: an env subcommand that finds a live
`ME_INJECT_V` already in its inherited env emits nothing, so the outer
contract survives whether or not the inner integration is live (without
this, which project governs a nested session would flip on Codex's
hook-trust state). Inheritance violates no goal — the inherited sentinel
still resolves an agent, never the user. Three consequences, accepted:
the inner session's MCP/hooks still resolve the *inner* dir (Codex MCP is
unreachable by env — unavoidable under any framing; visible only when
nesting across projects); `AI_AGENT` names the *initiating* harness, not
the executing one (authorization is identical either way; `me doctor`
reports both); and deliberate delegation to the inner project stays
possible — launch the nested harness with the contract stripped
(`env -u ME_INJECT_V -u ME_AS_AGENT -u ME_PROJECT_DIR codex …`) or use
`--config-dir` per call.

The shell surface (c) has two questions the other surfaces never need to
ask. MCP and hook invocations are harness surfaces *by construction* — when
`me mcp` or `me <harness> hook` runs, our code knows a harness is calling and
can apply agent-by-config directly. A plain `me` in the tool shell is just a
process; it must work out two independent facts from its environment:

1. **Where is the governing `.me` config?** (discovery — the config *path*).
   Answered by **injection**: the harness integration injects
   `ME_PROJECT_DIR` — the session's project dir, verbatim — into every
   shell command's env, and `me` walks up from that anchor at invocation
   time. Fallback: cwd walk-up — right in the common case, since every
   harness defaults shell commands to the project dir; the anchor exists
   for the excursions (`cd /tmp && me …`, an explicit `workdir`, a sibling
   repo reached via `--add-dir`, where a cwd walk-up finds nothing or the
   wrong project).

2. **Is a harness invoking me, or the human?** (activation — goals 1(c), 2,
   and 3). Answered by **detection**: `me` looks for evidence of a harness
   in its environment. The primary evidence is the injected sentinel itself
   (`ME_AS_AGENT=.me`, alongside `ME_INJECT_V` and `AI_AGENT=<harness>` per
   the emerging convention). The backstop evidence, for when injection
   silently didn't run (Codex's hook trust-gate, an uninstalled plugin, a
   harness we never integrated with, like Cursor), is the harness's own
   native marker — detect-agent wrapped with our `OPENCODE=1`/`AGENT=1`
   checks. The injected sentinel resolves the agent from config scope
   (project → global → `.user`; nothing → hard error); native-marker
   evidence *without* the injection's liveness var is a hard error too
   (the failsafe — see the surface sketch above). Detection is
   one-directional: evidence forces agent-or-die, but the absence of all
   evidence proves nothing — `me` then runs as the human (goal 2). The native markers stay the backstop rather
   than the primary because they are undocumented internals (Codex's and
   opencode's are source-verified, not contractual), while the injected
   signal is ours: versioned, uniform, and testable. False positives (a
   human in an IDE terminal carrying `CLAUDECODE=1`) fail toward less
   privilege, never more: agent mode is clamped by the owner's own access.

| Harness | (a) MCP server | (b) capture hooks | (c) shell: config path — how the `ME_PROJECT_DIR` anchor gets injected | (c) shell: harness detection — native backstop marker | Worktree sessions: worktree or original dir? |
|---|---|---|---|---|---|
| **Claude Code** | cwd walk-up (launch dir in practice); validated `CLAUDE_PROJECT_DIR` (server env) as the last-resort backstop — rescues the desktop-Linux `$HOME` spawn | payload `cwd` walk-up (worktree-correct; what the hook code does today); `CLAUDE_PROJECT_DIR` (validated) as fallback | SessionStart hook writes the contract vars (`ME_INJECT_V`, `AI_AGENT`, `ME_AS_AGENT=.me`, `ME_PROJECT_DIR`) to `$CLAUDE_ENV_FILE` (sourced before each Bash command); `ME_PROJECT_DIR` = the payload `cwd` verbatim, not `CLAUDE_PROJECT_DIR` | `CLAUDECODE=1` (documented; also set in IDE terminals) | Plain launch inside a worktree: **worktree** on all signals. Under `claude -w`: `CLAUDE_PROJECT_DIR` = the **original** repo root ([#27343](https://github.com/anthropics/claude-code/issues/27343)), and validation can't catch it — hence hooks/injection prefer payload `cwd` (**worktree**); the MCP spawn cwd under `-w` is unverified — with the var demoted below cwd walk-up, MCP resolves the **worktree** when the spawn cwd follows it, and falls to the mis-resolving var only when walk-up finds nothing |
| **opencode** | cwd walk-up (server spawns at project dir) | plugin passes its session `directory` as the anchor (`--project-dir`) | `shell.env` plugin hook sets the contract vars directly in every shell command's env — `ME_PROJECT_DIR` = the session-scoped `directory`, verbatim (deliberately **not** the per-command `input.cwd`, so a `workdir=/tmp` excursion keeps discovery; no walk-up in the plugin — `me` resolves from the anchor) | `OPENCODE=1` / `AGENT=1` (CLI/TUI path); `OPENCODE_CLIENT=desktop` (desktop app) — needs our wrapper; stock detect-agent checks only `OPENCODE_CLIENT` | **Worktree** by construction: the session `directory` lives inside the checkout the session was opened in, and MCP and shell children spawn at the instance dir |
| **Codex** | cwd walk-up (source-verified: child cwd defaults to the **session cwd** under the CLI; gap only in Desktop/VS Code hosts — env unreachable (`env_clear()`), no MCP `roots`, no pre-spawn hook; per-server `cwd` config is the only fix) | payload `cwd` passed as the anchor (`--project-dir`; hook runs at session cwd) | PreToolUse rewrite prepends `export ME_INJECT_V=… AI_AGENT=codex ME_AS_AGENT=.me ME_PROJECT_DIR=…` to the command | `CODEX_THREAD_ID` (always injected, survives `include_only`) — covers the window where hooks are untrusted | **Worktree**: no stored project-dir signal to go stale — everything derives from the session cwd, i.e. the checkout the session started in (Desktop caveat: cwd not rebound when switching project chats, [#20725](https://github.com/openai/codex/issues/20725)) |
| **Gemini CLI** | cwd walk-up (server spawns at launch dir) | `--project-dir "$GEMINI_PROJECT_DIR"` substituted into the hook command (anchor — walk-up handles subdir sessions) | BeforeTool hook rewrites `run_shell_command`'s `tool_input`, prepending `export ME_INJECT_V=… AI_AGENT=gemini-cli ME_AS_AGENT=.me ME_PROJECT_DIR=…` to the command | `GEMINI_CLI=1` (documented) | **Worktree**: `GEMINI_PROJECT_DIR` is literally the session cwd (no git-root resolution), so every surface follows the launch dir |

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
surface, by contrast, has both an injection channel (config path + context
markers) and a native-marker detection backstop — provided our
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
`ME_CONFIG_DIR` → `ME_PROJECT_DIR` → cwd walk-up → `CLAUDE_PROJECT_DIR`
(when set, validated — the last-resort backstop).
That is correct on three harnesses in all hosts and on Codex in the terminal;
Codex IDE hosts remain a known gap (mitigable only by a per-server `cwd` in
Codex config, or upstream fix). The var sits **below** cwd walk-up
deliberately: under `claude -w` it resolves to the main repo root, not the
worktree ([#27343](https://github.com/anthropics/claude-code/issues/27343)),
and `.me/`-existence validation can't catch that case, since the main
checkout contains `.me/` too — so the empirically-correct signal (the spawn
cwd, in practice the launch dir) is consulted first, and the documented
contract serves only as the backstop for spawns where walk-up finds nothing
(the desktop-Linux `$HOME` bug). Under `-w`, MCP then resolves the worktree
whenever the spawn cwd follows it (unverified) instead of being forced to
the main checkout by the var.

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
3. **Human-inside-harness terminals.** Two distinct cases. Claude's IDE
   integrated terminals set `CLAUDECODE=1` but never receive injection
   (`$CLAUDE_ENV_FILE` is sourced only before Bash tool commands) — so an
   unconditional failsafe would hard-error every human `me` there, with no
   way back (config never activates, and rejecting `--as-agent .user`
   would close the last exit). Hence the **TTY exemption**: the failsafe
   treats an interactive stderr as the human (harness tool shells never
   allocate a TTY) and runs as the user with a one-line notice;
   `ME_AS_AGENT=.user` remains the explicit override where the heuristic
   can't apply. opencode's built-in terminal is the opposite case: injected
   env *does* reach it, so `ME_AS_AGENT=.me` is present and activation is
   explicit — the TTY exemption lives only in the failsafe and doesn't
   override explicit activation — so a human typing `me` there acts as the
   agent. Accepted wrinkle, now confined to opencode: it hard-sets
   `OPENCODE_TERMINAL=1` on built-in-terminal children (unoverridable by
   plugins), so the adapter *could* elect to skip injection there — a
   deferred policy choice.
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
| `ME_INJECT_V=<version>` | always (integration live) | liveness + version marker — what the failsafe and `me doctor` key on |
| `AI_AGENT=<harness>` | always | identity, per the detect-agent convention; names the **initiating** harness — a nested harness inherits the initiator's contract (first-writer-wins) |
| `ME_AS_AGENT=.me` | always (integration live) | activation — the ordinary `.me` sentinel: resolve the agent from config scope, or fail |
| `ME_PROJECT_DIR=<session dir>` | always (integration live) | discovery **anchor** — `me` walks up from here at invocation time, regardless of cwd |

All four values are literals the harness already knows — adapters run no
discovery and parse no config. The single gate is **first-writer-wins**:
when a live `ME_INJECT_V` is already in the inherited env, the adapter
emits nothing, so a nested harness preserves the initiating session's
contract instead of clobbering it (see the anchor paragraph).
`ME_CONFIG_DIR` / `--config-dir` keeps its existing exact-location,
no-walk-up semantics as the explicit override (precedence: exact >
anchor > cwd walk-up > validated harness var). Anchoring rather than
injecting a resolved root also keeps resolution **fresh**: `me` re-walks on
every invocation, so a mid-session `me project init` is picked up
immediately — a resolved root frozen into `$CLAUDE_ENV_FILE` at
SessionStart would go stale.

**The sentinel is injected ungated, with uniform semantics.** `.me` resolves
the agent from config scope — project `agent:` → global `agent:`; an
effective `agent: .user` resolves to "the user, deliberately"; **nothing in
scope is a hard error**, the sentinel's existing fail-closed behavior, which
is exactly what a harness context requires (an agent, an explicit `.user`,
or a loud failure — never silent user-mode). Because resolution lives in the
CLI, adapters need no gating and parse no config — gating the injection on
the project file would wrongly skip the global fallback, and adapters must
never replicate precedence logic. Because the semantics are uniform, an
explicit `--as-agent .me` behaves identically to the injected one. `.user`
is honored from the global config or `.me/config.local.yaml` **and** as an
explicit `--as-agent .user` / `ME_AS_AGENT=.user` — the human escape hatch
for false-positive detection and human-run scripts — but **never from the
committed `.me/config.yaml`** (fatal `ProjectConfigError`; a committed
`.user` would unclamp every cloning teammate — see the threat model). So
user-mode harness work always traces to something deliberate, visible, and
chosen by *that* human: their own config file or an explicit flag/env on
the invocation — never a silent fallback, never someone else's commit.

How the cases fall out: **agent in scope** (project or global) — every
surface acts as it. **`.user` in scope** (local/global config, or explicit
flag/env — committed `.user` is fatal, see the threat model) — user-mode,
visibly chosen. **Nothing anywhere** — MCP fatal, hook skip,
shell sentinel error; rare after install-time default-agent provisioning,
and every message names the fix. **Injection silently dead in a
me-project** (untrusted Codex hooks, disabled plugin) — detection sees a
native marker without `ME_INJECT_V` and errors (goal 3). **Marker without
injection, but stderr is a TTY** — a human in an IDE integrated terminal:
runs as the human with a one-line notice (the TTY exemption). **Detected
but unintegrated harness** (non-TTY) — the failsafe errors and asks for a
GitHub issue; deliberately no workaround (see the failsafe sketch). **No
harness context at all** — the human's own terminal, running as the human
(goal 2).

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

Decisions locked before planning: failsafe is **unconditional on detection
in non-interactive contexts** (an interactive stderr TTY without injection
is treated as the human — see the failsafe sketch; unintegrated harnesses
get a file-an-issue error, no workaround); Codex/Gemini get **injection +
agent-by-config MCP now, capture hooks deferred**; agent identity stays
the `agent:` **name** in committed `.me/config.yaml` (each teammate owns
an agent by that name; TNT-182) with `.me/config.local.yaml` as the
per-user override; opencode's built-in terminal is treated as the agent in
v1 (`OPENCODE_TERMINAL` exemption deferred); harness-only surfaces
**require** an agent in scope — no-agent-anywhere is fatal for `me mcp`
and a skip for hooks — offset by install-time default-agent provisioning,
with `.user` (local/global config, or explicit `--as-agent .user` /
`ME_AS_AGENT=.user` — fatal in the committed file) as the deliberate
user-mode opt-out; **nested
harnesses inherit the initiating session's contract** — adapters are
first-writer-wins (emit nothing when a live `ME_INJECT_V` is already in
the inherited env).

### PR 1 — end-to-end: CLI core + Claude + opencode

One PR shipping the complete design for the two harnesses that already have
integrations, structured as three reviewable commit groups in this order —
**core** (no harness files touched; fully unit/integration-testable on its
own), then **Claude**, then **opencode**.

#### Core

1. **`packages/cli/harness-detect.ts`** (new): `detectHarness()` wrapping
   `@vercel/detect-agent` plus our extra checks (`OPENCODE=1`, `AGENT=1`,
   `OPENCODE_CLIENT`). Take the dependency; keep the wrapper so signals can
   be added without waiting on upstream.
2. **Resolver upgrade** (`packages/cli/project-config.ts`): project-dir
   order becomes `--config-dir` / `ME_CONFIG_DIR` (exact, no walk-up —
   unchanged) > `--project-dir` / `ME_PROJECT_DIR` (**new**: the anchor —
   walk up from it; when present it replaces the cwd as the walk-up
   origin, no fall-through) > cwd walk-up > **validated**
   `CLAUDE_PROJECT_DIR` (accepted only if the dir contains `.me/`;
   last-resort backstop — demoted below cwd because under `claude -w` it
   names the main checkout and validation can't catch it). Safe to apply
   globally: the harness vars only exist in hook, MCP, and injected-shell
   processes.
3. **Agent-by-config for harness contexts**: extend `resolveAsAgentFor`'s
   `.me` sentinel to resolve project `agent:` → global `agent:` (with
   `.user` resolving to deliberate user-mode), keeping its hard-throw when
   nothing is in scope. The surface commands (`me mcp`,
   `me <harness> hook`) activate it as if `--as-agent .me` were passed; the
   shell gets the identical resolution because the adapters inject
   `ME_AS_AGENT=.me` — the ordinary sentinel, whose existing hard-throw is
   exactly the required harness-shell behavior. No-agent-anywhere: fatal
   for MCP, skip for hooks, sentinel error for the shell — never silent
   user-mode in a harness context. An explicit `--as-agent` flag always
   beats the injected env.
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
   — a skip for hooks, a sentinel error for the injected shell — unless
   `.user` is chosen explicitly (`agent: .user` in the local or global
   file, or an explicit `--as-agent .user` / `ME_AS_AGENT=.user` on the
   invocation). In a harness context, user-mode must be a visible choice,
   never a default.
4. **Global fallback agent + `.user` sentinel + default-agent helper**: add
   `agent:` to the global `~/.config/me/config.yaml` schema; the `.me`
   sentinel resolves the project `agent:` first, else the global one
   (`resolveAsAgentFor`). Harness surfaces outside any project then run as
   the user's designated agent; the human terminal is unaffected (config
   never activates by itself). `.user` is a reserved sentinel value
   meaning "run as the user, deliberately" — valid in the global config
   and `.me/config.local.yaml` (`agent: .user`) **and** as an explicit
   `--as-agent .user` / `ME_AS_AGENT=.user` (the human escape hatch:
   false-positive detection, human-run scripts), but **fatal in the
   committed `.me/config.yaml`** (`ProjectConfigError` naming the allowed
   locations — a committed `.user` would unclamp every cloning teammate;
   see the threat model), so user-mode always traces to a deliberate,
   visible choice by that human — and agent-name validation must reject
   leading-dot names so sentinels can never collide with a real agent. Add
   a shared `ensureDefaultAgent()` helper (reusing the `provisionNewAgent`
   machinery from `me project init`) that provisions-or-finds the user's
   default agent and writes it as the global `agent:` — wired into the
   Claude/opencode installs below and the PR 2 installs, and named by the
   `me mcp` fatal error and `me doctor` as the one-command fix. Migration: existing installs hit
   the fatal on upgrade until they run it — the error message *is* the
   migration path.
5. **The failsafe** (root `preAction` in `packages/cli/index.ts`): error
   when `detectHarness()` fires ∧ no `ME_INJECT_V` ∧ no explicit
   `--as-agent`/`ME_AS_AGENT` ∧ credential is not an agent api key ∧
   stderr is **not** a TTY ∧ command not on the surface/diagnostic
   allowlist (`mcp`, `* hook`, `doctor`, `help`, `--version`, `login`,
   install/init flows). When stderr **is** a TTY (a human in an IDE
   integrated terminal — tool shells never allocate one), run as the user
   and print a one-line notice instead. The error message is branched:
   integrated harness → names it and the `me <harness> install` fix;
   detected-but-unintegrated harness (Cursor, Copilot, …) → names it and
   asks the user to file a GitHub issue requesting the integration — no
   workaround recipe (a static env setup can't supply the
   `ME_PROJECT_DIR` anchor, so it would mis-scope on excursions). PR 2
   refines the integrated branch for Codex: the error reads
   `~/.codex/hooks.json` and prescribes the `/hooks` trust approval when
   the entry is installed but injection didn't run.
6. Tests: detect wrapper matrix, resolver precedence + validation
   (project > global agent; `.user` opt-out from local/global config and
   as an explicit flag/env value, plus the committed-file fatal;
   no-agent-anywhere fatal for mcp / skip
   for hooks / sentinel error for shell), failsafe truth table (incl.
   agent-key, allowlist, and TTY exemptions; both branches of the error
   message), `me mcp` agent-by-config + eager
   startup validation against local Postgres.

#### Claude adapter

1. **`me claude env`** (new subcommand): reads the SessionStart payload and
   appends the contract block to `$CLAUDE_ENV_FILE` — idempotent block
   replacement (SessionStart refires on resume and `/clear`). All four vars
   are literals: `ME_PROJECT_DIR` is the payload `cwd` verbatim — the
   anchor `me` walks up from at each invocation, so a mid-session
   `me project init` is picked up immediately. One gate only:
   **first-writer-wins** — if the hook's own env already carries a live
   `ME_INJECT_V` (this Claude was spawned inside another session's
   contract), write nothing. Otherwise no discovery and no config parsing
   in the subcommand.
2. **`packages/claude-plugin/hooks/hooks.json`**: add the SessionStart hook
   invoking it. Existing Stop/SessionEnd hooks stay; their handler picks up
   agent-by-config from the core commits.
3. **`me project init`** (`packages/cli/commands/project.ts`): stop writing
   `ME_AS_AGENT` into committed `.claude/settings.json`
   (`writeClaudeSettingsEnv` call removed; add cleanup of the stale managed
   key). Keep writing `agent:` to `.me/config.yaml`. Existing checkouts
   with the old env keep working (explicit `ME_AS_AGENT` is still honored).
4. **Install-time default agent — no prompt, always `coder`**:
   `me claude install` runs the shared `ensureDefaultAgent()` step (reused
   by the opencode install below and the PR 2 installs). No-op when a
   global `agent:` is already set
   (including `.user`) or the credential is an agent api key (headless
   sandbox mode). Otherwise: adopt the user's existing `coder` agent if one
   exists, else create it with full permissions (the standard `write@/`
   grant, clamped by the owner's own access) and admit it to the active
   space; write global `agent: coder`; announce:

   ```
   Coding harnesses will act as your agent "coder" — their work is
   attributable, and you can restrict its access at any time. To use a
   different agent, set `agent:` in ~/.config/me/config.yaml or run
   `me project init` for a per-project choice.
   ```

   Rationale for a default instead of a wizard question: the choice is one
   reversible config line, so prompting front-loads a decision beginners
   can't yet evaluate — and the agents an expert already owns are typically
   project-scoped, i.e. wrong for the *global* default anyway. A fixed name
   keeps docs and errors concrete, and — since `agent:` resolves by name
   against the caller's own agents — a second machine's install adopts the
   same agent automatically. Other spaces are admitted on demand (the
   `me mcp` eager-validation error names the fix). Deliberate per-project
   agent choice stays in `me project init`; `--no-default-agent` skips the
   step for scripted installs.
5. Docs: `docs/project-config.md`, `docs/mcp-integration.md`, CLI reference.

#### opencode adapter

1. **`packages/cli/opencode/plugin-template.ts`**: add the `shell.env` hook
   — it sets the four contract vars, all literals:
   `ME_PROJECT_DIR` is the session-scoped `directory`, verbatim. No
   walk-up and no config parsing in the plugin; the one gate is
   first-writer-wins (skip when `process.env.ME_INJECT_V` is already set —
   opencode itself was launched inside another session's contract) — `me`
   resolves from the anchor at invocation time. `worktree` is deliberately
   unused (a git-root anchor would miss monorepo sub-project configs, and
   no other harness anchors on a git-root concept), and the per-command
   `input.cwd` is not the anchor either (a `workdir=/tmp` excursion would
   lose discovery exactly when injection matters). The `me opencode hook`
   shell-out passes the same anchor via `--project-dir` (today it leans on
   `process.cwd()`).
2. Bump the plugin template version/marker so `me opencode install`
   refreshes existing installs.

### PR 2 — Codex + Gemini: injection + MCP

The two rewrite-family adapters, structural twins: a `me`-owned env-hook
reads the stdin payload and returns a tool-input override with the same
`export …; ` prefix prepended (shlex-quoted, prefix-only); `ME_PROJECT_DIR`
is the payload `cwd`, verbatim (the anchor); any internal error or payload
mismatch is fail-open (emit nothing); first-writer-wins applies here too —
a live `ME_INJECT_V` in the hook's own env means emit nothing. A fail-open
on an *unrecognized payload shape* additionally logs the shape (structure
only, never command content — commands can carry secrets) to the local
state dir so `me doctor` can report it — otherwise a harness update that
changes the payload surfaces as unexplained failsafe errors. Vendor the
tested payload shapes.

1. **`me codex env-hook`** (new): PreToolUse payload → `updatedInput`;
   empty stdout on error; unrecognized payload shapes logged per the
   intro rule.
2. **`me codex install`**: additionally write the user-scope
   `~/.codex/hooks.json` PreToolUse entry. The definition must be
   **upgrade-stable**: Codex trusts hooks per definition hash, so the
   entry's text must not change across `me` versions — a bare
   `me codex env-hook` command, no version strings, no versioned absolute
   binary path (a Homebrew/mise-style `.../me/<version>/bin/me` would
   invalidate trust on every upgrade). Re-approval then follows only
   genuine definition changes, not releases. Verify during implementation
   that Codex hashes the definition text only (not the resolved binary),
   along with user-scope hook trust semantics. Document the one-time
   `/hooks` approval flow; the failsafe error and `me doctor` both point
   at it when the entry exists but injection isn't live.
3. Document the Desktop/VS Code MCP limitation + the per-server `cwd`
   workaround (goal-3 gap; doctor check in PR 3).
4. **`me gemini env-hook`** (new): BeforeTool payload →
   `hookSpecificOutput.tool_input` with the same prepended exports; same
   fail-open + shape-logging rules.
5. **`me gemini install`**: additionally write the user-scope
   `~/.gemini/settings.json` hooks entry (BeforeTool, matcher
   `run_shell_command`).

### PR 3 — `me doctor` (lightweight — no harness spawning)

A read-only diagnosis, on the failsafe allowlist by necessity (its job is to
run in states where other commands fail closed). Exit code non-zero on any
fail, so "run `me doctor` and fix what it says" works for agents and
scripts. Four sections:

1. **Context + resolution trace**: harness context (injected vars present,
   `ME_INJECT_V` vs CLI version; native marker *without* injection → "fails
   closed here for agents — rerun `me <harness> install`", or "no
   integration exists for <harness> — file a GitHub issue" when there is no
   installer, noting an interactive terminal runs as the human via the TTY
   exemption; nothing → human terminal; native markers naming a harness
   other than `AI_AGENT` → informational nested note, "contract initiated
   by claude, running under codex");
   which source won the project dir (exact / anchor / cwd walk-up /
   validated harness var) and the effective server/space/tree/agent with the layer
   each came from; bottom line: what memory operations here run as.
2. **Identity round trip** (the same shared check `me mcp` runs eagerly at
   startup): credential valid; resolved agent exists, is owned, is admitted
   to the active space; grant summary. Warn when no global `agent:` is set.
3. **Adapter installs**, file-level, per harness with a config dir present:
   Claude plugin + SessionStart hook; opencode plugin file + version marker
   ("stale — rerun `me opencode install`"); Codex `hooks.json` entry +
   definition-stability check (the entry's text matches what the current
   installer would write — a drifted definition means trust was
   invalidated), plus reminders for what we can't read from disk (whether
   the `/hooks` trust approval has been granted; Desktop/VS Code
   per-server `cwd` when the MCP entry lacks one); Gemini settings hooks +
   MCP entries; the env-hook payload-miss log — "N unrecognized payload
   shapes since <date>: a Codex/Gemini update likely changed the hook
   payload; upgrade `me` or file an issue."
4. **Project hygiene** (inside a `.me` project): `config.local.yaml`
   gitignored; committed `agent:` names an agent the caller owns (the
   cloned-repo teammate check) and is not `.user` (fatal everywhere else —
   doctor catches the `ProjectConfigError` and names the allowed
   locations); capture enabled but silently skipping (the
   one failure the runtime never surfaces); linked-worktree warning when
   the main checkout has a `config.local.yaml` this worktree lacks.

Deliberately dropped: the agent-env-style probe suite that launches each
harness's non-interactive mode. It needed all four CLIs installed and
authenticated, spent API tokens per run, and duplicated what the runtime
failsafe + eager MCP validation already surface at use time. Running
`me doctor` from inside a harness shell *is* the end-to-end injection test.
The manual verification matrix covers development; a CI e2e can automate it
later if it earns its keep.

### Verification (whole effort)

- `./bun run check` per PR; `./bun run check:full` before merge (local
  Postgres).
- Manual matrix (scripted where possible, checklist in the PR): for each
  harness — MCP call runs as agent; capture attributes to agent
  (Claude/opencode); `cd /tmp && me whoami` from the agent shell acts as
  agent (injection); with the adapter disabled, the same call **errors**
  (failsafe; on Codex, the installed-but-untrusted state must yield the
  `/hooks` message, not the install one); human terminal `me whoami` stays
  the human; human `me whoami`
  in an IDE integrated terminal (marker present, no injection, TTY) runs
  as the human with the notice; `ME_AS_AGENT=.user` runs as the user,
  visibly; non-me project with integration: `me` runs as the **global
  default agent** (or fails loudly with no agent in scope — never silently
  as the user).
- The nested-harness case (Claude → `codex exec`): the outer contract wins
  (first-writer) — the inner shell's `me whoami` acts as the initiating
  session's agent whether or not the inner integration is live; stripping
  the contract vars at launch hands the inner session its own; never a
  user-credential fallback.

### Deferred (tracked, not in this push)

Codex/Gemini capture hooks; the opencode built-in-terminal human exemption
(`OPENCODE_TERMINAL=1`); worktree fallback to the main checkout's
`config.local.yaml`; upstream PRs (detect-agent `OPENCODE`/`AGENT` checks,
Codex MCP roots/workspace-cwd).
- _MCP needs no injection (surface (a) has its own discovery), and on Codex
  it couldn't receive env anyway (`env_clear()`)._
