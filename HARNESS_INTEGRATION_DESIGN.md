# Design: Clean-slate coding-harness integrations (4 harnesses × 2 scopes)

**Status:** Draft for review (TNT-174 context; supersedes the incremental plan in
`TNT-174-PLAN.md`).
**Date:** 2026-07-01
**Premise:** This is an "if we wanted to do this right from scratch" exercise. It
does **not** assume the current integrations survive — they may be deleted and
rewritten. In particular, Claude Code is **not** assumed to be packaged as a
marketplace plugin (only if it benefits us — see §6).

Related: `PROJECT_CONFIG_DESIGN.md` (the `.me/` + agent-mode model; its §3
per-harness capability table, verified 2026-06-30), `AGENT_PROVISIONING_DESIGN.md`
(creating/granting the agent + writing `.me/config.yaml` — **out of scope here**).

---

## 1. Goal and shape

Every harness integration installs the same four asset classes:

1. **MCP** — register `me mcp` (stdio) so the harness gets the memory tools.
2. **Hooks** — capture: harness lifecycle events shell out to `me <harness> hook
   --event <e>`, which imports the session transcript (same code path as
   `me import <harness>`; incremental + idempotent, best-effort, exit 0).
3. **Skill** — the `memory-engine` skill (teaches when/how to use memory).
4. **Command** — the `/memory-recall` custom command.
5. **Context snippet** — a managed "memory pointer" block in the harness's
   context file (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`) — see §3.5.

Two scopes, with a hard semantic split:

| | **User scope** | **Project scope** |
|---|---|---|
| Written to | the harness's global config dir | the repo (committable, team-shared) |
| Identity | **the human** (login session) | **the project's agent** (`X-Me-As-Agent`) |
| Agent-mode wiring | **none** (and none injected) | `--as-agent .me` on every authored `me` command **+** `ME_AS_AGENT=.me` injected into the harness's tool shell |
| Routing (server/space/tree) | global `~/.config/me/` | `.me/config.yaml` (cwd walk-up discovery) |
| CLI entry point | `me <harness> install` | `me <harness> init` |
| Precondition | `me login` | `.me/config.yaml` with an `agent:` (provisioned by the init wizard — `AGENT_PROVISIONING_DESIGN.md`) |

Naming: the **implemented** primitives from TNT-170 / PR 127 — the global
`--as-agent <idOrName>` flag, `ME_AS_AGENT` env, the `X-Me-As-Agent` header, and
the `.me` sentinel (resolves to `.me/config.yaml`'s `agent`; **strict** — errors
when no agent is in scope). The design docs' older names (`--agent`, `ME_AGENT=1`,
`X-Me-Agent`) map 1:1 onto these.

### Principles

- **Nothing baked by default.** No `--server`/`--space`/api keys in any written
  file unless explicitly pinned. User scope resolves from the global config at
  runtime; project scope resolves from `.me/config.yaml`. Integration files are
  pure wiring and fully committable. **Exception — opt-in pins on `install`:**
  `me <harness> install --server <url> --space <slug>` bakes the pair into the
  MCP command, making a *global* harness install deterministic (user scope has
  no `.me/` to route it, so pinning is the only defense against the
  `me space use` race there). Pinning rules in §5. `init` takes **no** pin
  flags — project routing belongs to `.me/config.yaml`, and pins would override
  it (`--flag > .me`). (Headless/api-key installs are a separate, explicit path
  — out of scope here.)
- **Agent mode is conveyed two ways** (both cooperative-scoping, not containment
  — see `PROJECT_CONFIG_DESIGN.md` threat model):
  - **Tier-1 (required):** every `me` command *we author* — MCP command, hook
    commands, embedded CLI calls in command/skill text, git hook — carries
    `--as-agent .me` explicitly.
  - **Tier-2 (ad-hoc CLI):** inject `ME_AS_AGENT=.me` into the harness's tool
    shell via the harness's env mechanism, so the agent's *own* `me` invocations
    also run as the agent.
- **Same assets, different renderers.** One canonical source per asset (skill
  text, recall-command text, capture-hook handler) rendered into each harness's
  native format/location. No harness-specific content forks.
- **Idempotent + removable.** Every file we write carries a managed marker (or is
  a managed block inside a shared file) so re-runs refresh in place and
  `--remove` cleanly uninstalls.
- **cwd is the project.** All four harnesses launch MCP servers/hooks with cwd in
  the project, so `.me/` cwd discovery works. `--config-dir <abs>` /
  `ME_CONFIG_DIR` is the escape hatch if a harness proves otherwise.

---

## 2. The canonical `me` invocations

| Asset | User scope | Project scope |
|---|---|---|
| MCP server | `me mcp` (+ `--server <url> --space <slug>` when pinned) | `me --as-agent .me mcp` |
| Capture hook | `me <h> hook --scope user --event <e>` | `me --as-agent .me <h> hook --scope project --event <e>` |
| Git post-commit | *(not installed)* | `me --as-agent .me import git` |
| Embedded CLI in command/skill text | `me search …` | `me --as-agent .me search …` |
| Tool-shell env | *(none)* | `ME_AS_AGENT=.me` |

Notes:
- `--as-agent` is a root/global flag; canonical position is before the
  subcommand. (Commander accepts either position; we standardize on before.)
- Strictness: `--as-agent .me` **fails** when no `.me` agent is in scope. At
  project scope that's the desired invariant (init provisions the agent). Capture
  hooks and the git hook are best-effort (log + exit 0 / backgrounded), so a
  broken `.me` never blocks a session or a commit; the MCP server fails loudly —
  correct, since project scope *means* agent identity.
- The hook `--scope` flag exists for **double-capture dedup** (§5): verified
  (P0) that Claude, Codex, and OpenCode all *merge* hooks/plugins across user +
  project config — when both scopes are installed, **both** capture hooks fire.
  The `--scope user` invocation defers (exit 0) when the same harness's
  project-scope capture is installed in the event's project; `--scope project`
  always runs.
- An agent api key in `ME_API_KEY` trumps the header (it already *is* the agent);
  a user PAT lets `X-Me-As-Agent` apply. No change needed per scope.

---

## 3. Per-harness × per-scope specs

Each cell lists the concrete steps `install` (user) / `init` (project) performs.
Steps shared by both scopes appear once with the path differing per scope.

### 3.1 Claude Code

Native mechanisms (clean slate — **no marketplace plugin**; see §6):

| Asset | User scope location | Project scope location |
|---|---|---|
| MCP | `claude mcp add --scope user me -- <cmd>` (writes `~/.claude.json`) | `claude mcp add --scope project me -- <cmd>` (writes `.mcp.json` at repo root, committable) |
| Hooks | `~/.claude/settings.json` → `hooks` | `.claude/settings.json` → `hooks` (committed) |
| Skill | `~/.claude/skills/memory-engine/SKILL.md` | `.claude/skills/memory-engine/SKILL.md` |
| Command | `~/.claude/commands/memory-recall.md` | `.claude/commands/memory-recall.md` |
| Tool-shell env | — | `.claude/settings.json` → `"env": { "ME_AS_AGENT": ".me" }` |

**A. User scope — `me claude install`**
1. **MCP:** `claude mcp add --scope user me -- me mcp` (append
   `--server <url> --space <slug>` when pinned — §5).
2. **Hooks:** upsert into `~/.claude/settings.json` (managed JSON merge — we own
   only the `me`-named hook entries):
   ```json
   {
     "hooks": {
       "Stop":       [{ "hooks": [{ "type": "command", "command": "me claude hook --scope user --event stop",        "async": true, "timeout": 60 }] }],
       "SessionEnd": [{ "hooks": [{ "type": "command", "command": "me claude hook --scope user --event session-end", "async": true, "timeout": 60 }] }]
     }
   }
   ```
   (Verified: `SessionEnd` hooks default to a 1.5s timeout, raised to per-hook
   `timeout` capped at 60 — keep the explicit `"timeout": 60`. Hooks from user +
   project settings **merge and all run**; the `--scope user` flag lets the
   handler defer when project capture is installed — §5 dedup.)
3. **Skill:** write `~/.claude/skills/memory-engine/SKILL.md` (rendered from the
   canonical skill source; managed marker in frontmatter comment).
4. **Command:** write `~/.claude/commands/memory-recall.md` (embedded `me` calls
   carry no as-agent flag).
5. **Context snippet:** managed block in `~/.claude/CLAUDE.md` (§3.5, user
   variant).
6. **No env injection** — and `install` must *not* write `ME_AS_AGENT` anywhere
   global.

**B. Project scope — `me claude init`** (precondition: `.me/config.yaml` with `agent:`)
1. **MCP:** `claude mcp add --scope project me -- me --as-agent .me mcp`
   → produces a committable `.mcp.json`:
   ```json
   { "mcpServers": { "me": { "command": "me", "args": ["--as-agent", ".me", "mcp"] } } }
   ```
2. **Hooks:** upsert into `.claude/settings.json`: same two hooks with
   `me --as-agent .me claude hook --scope project --event <e>`.
3. **Tool-shell env (Tier-2):** in the same `.claude/settings.json` upsert:
   `"env": { "ME_AS_AGENT": ".me" }`. (Team-shared, committed — consistent with a
   committed `.me/config.yaml`. A developer can override per-machine in
   `.claude/settings.local.json`, which Claude auto-gitignores.)
4. **Skill:** `.claude/skills/memory-engine/SKILL.md`.
5. **Command:** `.claude/commands/memory-recall.md` (embedded `me` calls carry
   `--as-agent .me`).
6. **Project extras:** git post-commit hook (`me --as-agent .me import git`,
   managed block, backgrounded) + CLAUDE.md memory-pointer block + one-time
   session/git backfill (wizard steps).

### 3.2 OpenCode

Native mechanisms:

| Asset | User scope location | Project scope location |
|---|---|---|
| MCP | `~/.config/opencode/opencode.json` → `mcp.me` | `opencode.json` at repo root → `mcp.me` |
| Hooks | generated TS plugin in `~/.config/opencode/plugins/` | generated TS plugin in `.opencode/plugins/` |
| Skill | `~/.config/opencode/skills/memory-engine/SKILL.md` | `.opencode/skills/memory-engine/SKILL.md` |
| Command | `~/.config/opencode/commands/memory-recall.md` | `.opencode/commands/memory-recall.md` |
| Tool-shell env | — | the generated plugin's `shell.env` hook |

OpenCode has no declarative hooks — capture is a tiny generated **plugin** (TS
file, marker header) whose event handlers shell out to the `me` CLI via Bun `$`
(fire-and-forget, `.nothrow()`).

**A. User scope — `me opencode install`**
1. **MCP:** merge into `~/.config/opencode/opencode.json`:
   ```json
   { "mcp": { "me": { "type": "local", "command": ["me", "mcp"] } } }
   ```
   (command gains `"--server", "<url>", "--space", "<slug>"` when pinned — §5).
2. **Hooks:** write `~/.config/opencode/plugins/memory-engine.ts` — on
   `session.idle` / `session.deleted` runs
   `$\`me opencode hook --scope user --event <e> --session <id>\``.
   (Verified: plugins from both scopes **all run** — no shadowing — hence the
   `--scope` dedup, §5. `session.idle` is deprecated upstream in favor of
   `session.status` but still published + documented; follow-up noted in §8.)
3. **Skill:** `~/.config/opencode/skills/memory-engine/SKILL.md`.
4. **Command:** `~/.config/opencode/commands/memory-recall.md`.
5. **Context snippet:** managed block in `~/.config/opencode/AGENTS.md` (§3.5,
   user variant).
6. **No env injection**; the generated plugin's `shell.env` hook is omitted.

**B. Project scope — `me opencode init`**
1. **MCP:** merge into repo-root `opencode.json`:
   ```json
   { "mcp": { "me": { "type": "local", "command": ["me", "--as-agent", ".me", "mcp"] } } }
   ```
2. **Hooks:** write `.opencode/plugins/memory-engine.ts` — same events, command
   `me --as-agent .me opencode hook --scope project --event <e> --session <id>`.
3. **Tool-shell env (Tier-2):** the same generated plugin exports the
   `shell.env` hook (verified exact signature:
   `"shell.env"?: (input: { cwd, sessionID?, callID? }, output: { env: Record<string,string> }) => Promise<void>`)
   setting `output.env.ME_AS_AGENT = ".me"` — injected into all shell execution
   (AI tools and user terminals).
4. **Skill:** `.opencode/skills/memory-engine/SKILL.md`.
5. **Command:** `.opencode/commands/memory-recall.md` (embedded calls carry
   `--as-agent .me`).
6. **Project extras:** git hook + AGENTS.md pointer + backfills (as Claude).

### 3.3 Codex

Native mechanisms (P0-verified 2026-07-01 against developers.openai.com/codex +
openai/codex source):

| Asset | User scope location | Project scope location |
|---|---|---|
| MCP | `~/.codex/config.toml` → `[mcp_servers.me]` | `.codex/config.toml` → `[mcp_servers.me]` (trust-gated) |
| Hooks | `~/.codex/hooks.json` (or `[hooks]` in config.toml) | `.codex/hooks.json` (trust-gated + per-hook hash trust) |
| Skill | `~/.agents/skills/memory-engine/SKILL.md` | `.agents/skills/memory-engine/SKILL.md` (**shared dir** — also read by Gemini + OpenCode, §5) |
| Command | *(custom prompts are deprecated + user-only — recall ships as a second skill instead)* | *(same — skill)* |
| Tool-shell env | — | `.codex/config.toml` → `[shell_environment_policy] set` |

Verified hook facts: hooks are **stable and enabled by default**
(`[features] hooks = true`). Events include `SessionStart`, `UserPromptSubmit`,
`Stop`, `SubagentStop` — there is **no `SessionEnd`**; `Stop` (turn end) is the
capture point (fine — the import is incremental, so per-turn capture flushes
everything). Payload arrives as JSON on stdin with `session_id`,
**`transcript_path`**, `cwd`, `hook_event_name`; timeout unit is **seconds**
(default 600); only `type: "command"` runs (`async: true` is parsed but
skipped — do not rely on it). All hook layers **merge and run** (§5 dedup).
Sessions live at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — exactly what
`packages/cli/importers/codex.ts` already parses.

**A. User scope — `me codex install`**
1. **MCP:** managed TOML merge into `~/.codex/config.toml`:
   ```toml
   [mcp_servers.me]
   command = "me"
   args = ["mcp"]
   ```
   (args gain `"--server", "<url>", "--space", "<slug>"` when pinned — §5).
2. **Hooks:** managed merge into `~/.codex/hooks.json`:
   ```json
   { "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "me codex hook --scope user --event stop", "timeout": 60 }] }] } }
   ```
   New `me codex hook` handler (thin adapter): read the stdin payload, take
   `transcript_path`, run `importTranscriptFile` with the codex importer.
3. **Skills:** `~/.agents/skills/memory-engine/SKILL.md` + the recall skill
   `~/.agents/skills/memory-recall/SKILL.md` (Codex custom prompts are
   deprecated; skills are the replacement and are shareable).
4. **Context snippet:** managed block in `~/.codex/AGENTS.md` (§3.5, user
   variant — AGENTS.md is Codex's first-class context file).
5. **No env injection.**

**B. Project scope — `me codex init`**
1. **MCP:** `.codex/config.toml`:
   ```toml
   [mcp_servers.me]
   command = "me"
   args = ["--as-agent", ".me", "mcp"]
   ```
2. **Hooks:** `.codex/hooks.json`, command
   `me --as-agent .me codex hook --scope project --event stop`.
3. **Tool-shell env (Tier-2):** in `.codex/config.toml`:
   ```toml
   [shell_environment_policy]
   set = { ME_AS_AGENT = ".me" }
   ```
   (Verified syntax; the default KEY/SECRET/TOKEN exclude filter doesn't match
   `ME_AS_AGENT`.)
4. **Skills:** `.agents/skills/memory-engine/` + `.agents/skills/memory-recall/`
   (the shared cross-harness dir — written once, §5).
5. **Project extras:** git hook + AGENTS.md pointer + backfills
   (`me import codex` exists and its layout assumptions are verified current).
6. **Trust gating (verified):** project `.codex/` layers load only when the
   project is trusted (`projects."<path>".trust_level = "trusted"`), and
   non-managed hooks additionally require per-hook hash-pinned review via
   `/hooks` — a changed hook command re-prompts. Init prints a note telling the
   user to trust the project and approve the hook; nothing we can automate.

### 3.4 Gemini CLI

Native mechanisms (P0-verified 2026-07-01 against gemini-cli docs/source + an
isolated empirical `gemini mcp add` test):

| Asset | User scope location | Project scope location |
|---|---|---|
| MCP | `gemini mcp add --scope user` (→ `~/.gemini/settings.json`) | `gemini mcp add --scope project` (→ `.gemini/settings.json`; **project is gemini's default scope**) |
| Hooks | `~/.gemini/settings.json` → `hooks` | `.gemini/settings.json` → `hooks` (fingerprinted; changed commands re-prompt trust) |
| Skill | `~/.agents/skills/memory-engine/SKILL.md` (shared dir; `~/.gemini/skills/` also works) | `.agents/skills/memory-engine/SKILL.md` (**shared dir**, §5; `.agents/` beats `.gemini/` within the tier) |
| Command | `~/.gemini/commands/memory-recall.toml` | `.gemini/commands/memory-recall.toml` |
| Tool-shell env | — | `.gemini/.env` (`ME_AS_AGENT=.me`; `.gemini/.env` vars are never excluded) |

Verified hook facts: full lifecycle hooks. Capture events: **`AfterAgent`**
(per-turn, the reliable point) + **`SessionEnd`** (final flush — best-effort:
the CLI does **not** wait for it). Payload on stdin carries `session_id`,
**`transcript_path`**, `cwd`, `hook_event_name`; timeout unit is **ms**.
Sessions are JSONL at `~/.gemini/tmp/<project_hash>/chats/session-*.jsonl`
(line 1 metadata; then `MessageRecord`s with `type: 'user' | 'gemini'`,
`toolCalls`, `$set`/`$rewindTo` records) — the new importer's target format.
Skills are first-class (agentskills.io standard, workspace > user precedence).

**A. User scope — `me gemini install`**
1. **MCP:** `gemini mcp add --scope user me me mcp` (command comes inline after
   the name, no `--` separator — empirically verified shape
   `mcpServers.me.{command,args,env}`; append `--server <url> --space <slug>`
   when pinned — §5).
2. **Hooks:** managed merge into `~/.gemini/settings.json`:
   ```json
   { "hooks": { "AfterAgent": [{ "hooks": [{ "type": "command", "command": "me gemini hook --scope user --event after-agent", "timeout": 60000 }] }],
                "SessionEnd": [{ "hooks": [{ "type": "command", "command": "me gemini hook --scope user --event session-end", "timeout": 60000 }] }] } }
   ```
   New `me gemini hook` handler: read stdin payload → `transcript_path` →
   `importTranscriptFile` with the **new gemini importer** (§7).
3. **Skill:** `~/.agents/skills/memory-engine/SKILL.md` (+ recall skill — the
   shared dir also serves Codex; Gemini additionally gets the TOML command
   below since gemini commands support `!{...}` shell).
4. **Command:** `~/.gemini/commands/memory-recall.toml` (TOML: `prompt = "..."`,
   optional `description`; `!{...}` runs shell with a consent dialog).
5. **Context snippet:** managed block in `~/.gemini/GEMINI.md` (§3.5, user
   variant).
6. **No env injection.**

**B. Project scope — `me gemini init`**
1. **MCP:** `gemini mcp add --scope project me me --as-agent .me mcp`
   → `.gemini/settings.json` (committable).
2. **Hooks:** `.gemini/settings.json`, command
   `me --as-agent .me gemini hook --scope project --event <e>`.
3. **Tool-shell env (Tier-2):** write managed block into `.gemini/.env`:
   ```
   ME_AS_AGENT=.me
   ```
   (Verified: `.gemini/.env` vars are never excluded; default env redaction is
   off, and `ME_AS_AGENT` isn't in `advanced.excludedEnvVars` (default
   `["DEBUG","DEBUG_MODE"]`), so it reaches tool shells and MCP servers.
   Caveat: strict redaction is forced under GitHub Actions.)
4. **Skill:** `.agents/skills/memory-engine/` (+ recall — shared with Codex/
   OpenCode, §5).
5. **Command:** `.gemini/commands/memory-recall.toml` (embedded calls carry
   `--as-agent .me`).
6. **Project extras:** git hook + GEMINI.md pointer + backfills (needs the new
   Gemini importer; the repo can also set `context.fileName` to include
   `AGENTS.md` — see §3.5).

### 3.5 The context snippet (CLAUDE.md / AGENTS.md / GEMINI.md)

The fifth asset: a managed **memory pointer** block in the harness's natural
context file, so the model is *told* memory exists and when to reach for it (MCP
tools alone are easy for a model to ignore). Same discipline as everything else:
marker-delimited block, upserted in place on re-run, removed by `--remove`.

| Harness | User scope | Project scope |
|---|---|---|
| **Claude** | `~/.claude/CLAUDE.md` | `<repo>/CLAUDE.md` |
| **OpenCode** | `~/.config/opencode/AGENTS.md` | `<repo>/AGENTS.md` |
| **Codex** | `~/.codex/AGENTS.md` | `<repo>/AGENTS.md` |
| **Gemini** | `~/.gemini/GEMINI.md` | `<repo>/GEMINI.md` (or `AGENTS.md` when the repo sets `contextFileName`) |

Two content variants, matching the scope's identity split:

**User variant** (general, identity-neutral — "you have memory"):

```markdown
<!-- >>> memory-engine (managed by `me install`) >>> -->
You have persistent memory: Memory Engine, via the `me_memory_*` MCP tools.
- Search memory (`me_memory_search`) before starting non-trivial work — prior
  decisions, conventions, and gotchas are stored there.
- Store durable knowledge (decisions, fixes, project facts) as you learn it.
<!-- <<< memory-engine <<< -->
```

**Project variant** (adds routing + identity facts — "this project has memory"):

```markdown
<!-- >>> memory-engine (managed by `me init`) >>> -->
This project has persistent memory in Memory Engine (`me_memory_*` MCP tools).
- Project memory lives under `<tree from .me/config.yaml>`; sessions and git
  history are captured there automatically.
- Search project memory before exploring the code — prior decisions, history,
  and architecture notes are already stored.
- Memory access runs as the project's agent (`.me/config.yaml` `agent`);
  ad-hoc `me` CLI calls inherit this via `ME_AS_AGENT=.me`.
<!-- <<< memory-engine <<< -->
```

The project variant is **templated** (the tree path, and the space/server when
pinned) — rendered from `.me/config.yaml` at init time, and refreshed by a
re-run when the config changes (the existing `memoryPointerUpToDate` check).

Wrinkles:

- **Shared `AGENTS.md` (OpenCode + Codex, and anything else that reads it):**
  the project block is **harness-agnostic** — one canonical block, shared
  markers (`managed by \`me init\``, no harness name in the marker), rendered
  from one source. The second harness's `init` finds the block up to date and
  does nothing. This is why the markers must not embed the harness name.
- **Claude does NOT read `AGENTS.md` natively** (P0-verified: "Claude Code
  reads `CLAUDE.md`, not `AGENTS.md`"). The dedup mechanism for Claude is the
  **`@AGENTS.md` import**: when the repo already carries the shared `AGENTS.md`
  block, Claude's init can write a minimal CLAUDE.md block containing
  `@AGENTS.md` instead of duplicating the content (Claude's import syntax pulls
  it in at load time). Full-content CLAUDE.md block when no AGENTS.md exists.
- **Gemini + `AGENTS.md`:** gemini's context file setting is `context.fileName`
  (string **or array**) — a repo can set
  `"context": { "fileName": ["GEMINI.md", "AGENTS.md"] }` in
  `.gemini/settings.json` to read the shared block too. Optional init step;
  default stays GEMINI.md.
- **User + project both installed:** the harness loads both context files;
  the two variants are written to not contradict (the user variant is a strict
  subset in spirit — "you have memory" vs "this project's memory is here").
- The existing mechanism (`packages/cli/agent/memory-pointer.ts`:
  `writeMemoryPointer` / `memoryPointerUpToDate`) already implements the
  upsert + up-to-date checks; it generalizes to user-scope targets and the
  shared-block markers.

---

## 4. The 8-cell summary

| Harness | User scope (`install`) — human | Project scope (`init`) — agent |
|---|---|---|
| **Claude** | `claude mcp add --scope user` · hooks in `~/.claude/settings.json` · skill+command in `~/.claude/` · pointer in `~/.claude/CLAUDE.md` | `.mcp.json` via `--scope project` · hooks+`env.ME_AS_AGENT` in `.claude/settings.json` · skill+command in `.claude/` · git hook · CLAUDE.md pointer |
| **OpenCode** | `mcp.me` in `~/.config/opencode/opencode.json` · plugin/skill/command in `~/.config/opencode/` · pointer in `~/.config/opencode/AGENTS.md` | `mcp.me` in repo `opencode.json` · plugin (with `shell.env` → `ME_AS_AGENT`) /skill/command in `.opencode/` · git hook · AGENTS.md pointer |
| **Codex** | `[mcp_servers.me]` in `~/.codex/config.toml` · hooks in `~/.codex/hooks.json` · skills in `~/.agents/skills/` · pointer in `~/.codex/AGENTS.md` | `[mcp_servers.me]` + `[shell_environment_policy]` in `.codex/config.toml` · hooks in `.codex/hooks.json` (trust-gated) · skills in `.agents/skills/` · git hook · AGENTS.md pointer |
| **Gemini** | `gemini mcp add --scope user` · hooks in `~/.gemini/settings.json` · skills in `~/.agents/skills/` + command in `~/.gemini/commands/` · pointer in `~/.gemini/GEMINI.md` | `gemini mcp add --scope project` · hooks in `.gemini/settings.json` · `ME_AS_AGENT` in `.gemini/.env` · skills in `.agents/skills/` + command in `.gemini/commands/` · git hook · GEMINI.md pointer |

Every project-scope `me` command is `me --as-agent .me …`; every user-scope
command is plain `me …`.

---

## 5. Cross-cutting behavior

- **Idempotency:** every written file carries a managed marker; entries inside
  shared files (`settings.json`, `config.toml`, `opencode.json`, `.env`,
  post-commit) are managed blocks/keys we upsert and can remove. Re-running
  `install`/`init` refreshes in place. Each command gets `--remove`.
- **Shared init engine:** the existing `InitStep` picker generalizes — steps are
  (backfill session import, hooks, MCP, skill, command, git import, git hook,
  memory pointer), instantiated per harness. `init` is **project-scope only**
  (no `--scope`); `install` is **user-scope only** (no `--scope`). The old
  scope flags disappear — scope is the command.
- **Pinning (`--server` / `--space` on `install` only):**
  - Default (no flags): bake nothing; the MCP server resolves server/session/
    space from the live global config at runtime.
  - `--space` **implies `--server`**: a space slug only exists on its server, so
    a space pin resolves the server (flag > `ME_SERVER` > default) and bakes the
    **pair** together.
  - Validate at install time that a login session exists for the pinned server
    (else the MCP server fails at runtime); warn, don't write, on failure.
  - **Precedence gotcha (document loudly):** flags beat `.me`
    (`--flag > ME_* env > .me > global`), so a user-scope pin **overrides a
    project's `.me/config.yaml`** in any repo where the user has *not* run
    `me <harness> init`. Once `init` has run, the project-scope MCP entry
    shadows the user-scope one and the pin is irrelevant there. Per-project
    routing belongs to `init` + `.me/`; pins are for fixing a *global* install
    to one target.
  - A pin is static: it does not follow `me space use`. Re-run `install` (or
    `--remove` + reinstall) to move it.
  - `init` takes **no** pin flags.
- **Precondition checks:** `init` fails fast (before writing anything) when no
  `.me/config.yaml` `agent` is in scope, with a pointer to the provisioning
  wizard (TNT-168 / `AGENT_PROVISIONING_DESIGN.md`). `install` fails fast when
  not logged in.
- **Coexistence + double-capture dedup:** user + project scope can both be
  installed. For **MCP**, per-key config precedence applies in all four
  harnesses — the project `me` entry shadows the user one. For **hooks/plugins**
  it does **not** (P0-verified): Claude merges hooks across user+project+local
  settings and runs all of them (deduping only *identical* commands — ours
  differ by `--as-agent`); Codex runs all hook layers; OpenCode runs plugins
  from both scopes with no shadowing. Without mitigation, a both-scopes install
  captures every session **twice under two identities** (human + agent).
  Mitigation: every authored hook command carries `--scope user|project`; the
  shared `me <h> hook` handler, when invoked with `--scope user`, checks
  whether the same harness's **project-scope capture artifact** exists in the
  event's project (e.g. our managed hook entry in `.claude/settings.json`, the
  `.opencode/plugins/memory-engine.ts` marker file, `.codex/hooks.json` entry,
  `.gemini/settings.json` entry) and **defers** (logs + exit 0) when it does.
  `--scope project` always captures. Deferral is by artifact-presence, not by
  `.me` presence — so a project with a `.me` but no project-scope capture
  install still gets user-scope (human) captures.
- **Shared skills dir (`.agents/skills/`):** Codex, Gemini, and OpenCode all
  read `.agents/skills/` (project) and `~/.agents/skills/` (user) — the skill
  (and, for Codex, the recall skill) is written **once** there and served to
  all three; only Claude needs its own copy (`.claude/skills/`). Installers use
  shared markers (no harness name), same discipline as the shared `AGENTS.md`
  block: the second harness's install/init finds it up to date and does
  nothing. Residual risk: OpenCode docs advise unique skill names across
  locations (same-name user + project skill behavior is undocumented) — the
  content is identical either way; noted in §8.
- **Built-in terminal wrinkle:** with Tier-2 injected, a human running `me`
  inside the harness's terminal acts as the agent. Documented, accepted.
- **Headless/api-key path:** out of scope here; `ME_API_KEY` in the harness's
  environment keeps working (an agent key ignores the header by design).

---

## 6. Claude: plugin or not?

**Recommendation: drop the marketplace plugin; write files directly (as above).**

| | Marketplace plugin | Direct file writes |
|---|---|---|
| Scope control | ✗ one static, user-global artifact — cannot differ per scope (the exact problem that blocked as-agent wiring) | ✓ full user/project parity with the other 3 harnesses |
| Agent mode | ✗ needs `userConfig` placeholder plumbing (`${user_config.as_agent}`, blank-flag cleaning) | ✓ just write the flag/env where it belongs |
| Install UX | ✓ one command, `/plugin` config UI, marketplace updates | ✓ `me claude install|init` is already one command; updates via re-run (`me upgrade` can re-render) |
| Distribution | ✓ discoverable in the marketplace | ✗ requires the `me` CLI first (but every path here already does) |
| Maintenance | two artifacts (plugin repo + CLI) | one (CLI renders everything) |

The plugin's only real advantage is marketplace discoverability — worth keeping
as a *thin optional wrapper* later (a plugin whose hooks/MCP call the same `me`
commands), but not as the primary mechanism. Direct writes make Claude identical
in shape to OpenCode/Codex/Gemini and remove the static-artifact constraint.

---

## 7. New work this implies (delta vs. today)

1. **Codex:** `me codex hook` handler (reads stdin payload → `transcript_path`
   → existing codex importer) + `hooks.json` installer + `.agents/skills/`
   installer + `.codex/config.toml` TOML managed merge. MCP install moves from
   `codex mcp add` (global CLI) to scoped config writes.
2. **Gemini:** `me gemini hook` handler **and a Gemini session importer**
   (`packages/cli/importers/gemini.ts`, JSONL `chats/session-*.jsonl` format —
   verified shape) — neither exists. Hooks/skill/command installers.
3. **Claude:** replace plugin install with direct writes (`~/.claude/` vs
   `.claude/` + `.mcp.json`); port skill + recall command (exist today only for
   OpenCode); retire `packages/claude-plugin` (or demote to optional wrapper).
4. **OpenCode:** smallest delta — add `--as-agent .me` + `shell.env` injection at
   project scope; collapse `--scope` flags into the install/init split.
5. **Shared:** canonical asset sources (skill/command/hook-handler/context
   snippet) with per-harness renderers; managed TOML/JSON/env merge helpers;
   `--remove` on both commands everywhere; git-hook block gains
   `--as-agent .me` (project); the memory pointer generalizes to user-scope
   targets + the harness-agnostic shared `AGENTS.md` block + `.me`-templated
   project variant (§3.5); `install` pin flags (`--server`/`--space`, §5) reuse
   the existing `me mcp --server/--space` + `blankFlag` plumbing.
6. **Docs:** rewrite `docs/cli/me-claude|opencode|codex|gemini.md` +
   `mcp-integration.md` around the install/init × human/agent matrix.

## 8. Verification log (P0, 2026-07-01) — all items resolved

All five original verification items were researched against current harness
docs/source + empirical tests (isolated temp dirs; no real config touched).
Findings are folded into §2–§5 above. Resolution summary:

1. **Codex hooks** ✅ — stable, default-on. Events: `SessionStart`,
   `UserPromptSubmit`, `Stop`, `SubagentStop`, … (**no `SessionEnd`**; capture
   on `Stop`). Stdin JSON payload carries `transcript_path`. `hooks.json` or
   `[hooks]` TOML at both scopes; project hooks are trust-gated **and**
   per-hook hash-trusted (`/hooks`). Prompts deprecated (user-only) → recall
   ships as a skill. **Skills at `.agents/skills/` / `~/.agents/skills/`**, not
   `.codex/`. Sessions `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — matches
   our importer exactly.
2. **Gemini hooks + storage** ✅ — `hooks` key in settings.json; capture on
   `AfterAgent` (per-turn) + `SessionEnd` (best-effort, CLI doesn't wait).
   Payload carries `transcript_path`; timeouts in ms. Sessions: JSONL
   `~/.gemini/tmp/<hash>/chats/session-*.jsonl` (metadata line 1, then
   user/gemini `MessageRecord`s with `toolCalls`, `$set`/`$rewindTo`). Skills
   first-class (`.agents/skills/` shared tier works). `context.fileName`
   accepts an array incl. `AGENTS.md`. `gemini mcp add` verified empirically
   (default scope **project**; `mcpServers.me.{command,args,env}`).
3. **Claude `mcp add --scope project`** ✅ — empirically verified: writes
   `.mcp.json` with `{type:"stdio", command, args, env:{}}`, args preserved
   verbatim including leading `--as-agent .me`. User/local MCP live in
   `~/.claude.json`. **Claude does not read AGENTS.md** (bridge: `@AGENTS.md`
   import in CLAUDE.md). `SessionEnd` hook default timeout 1.5s → always set
   explicit `timeout`. Hooks merge across scopes (all run).
4. **MCP cwd = project dir** ✅ for all four (Codex: session cwd via source;
   Gemini: inherits CLI cwd, `cwd` field available; Claude: empirically
   verified, though docs recommend `CLAUDE_PROJECT_DIR`; OpenCode: instance
   dir via source). `--config-dir` escape hatch stays unnecessary for now.
5. **OpenCode `shell.env`** ✅ — exact hook confirmed:
   `"shell.env"?: (input: {cwd, sessionID?, callID?}, output: {env}) => Promise<void>`;
   injects into all shell execution. MCP env key is `environment`. Plugins from
   both scopes all run (no shadowing) → the `--scope` hook dedup (§5).

### Residual risks / follow-ups

- **Claude settings `env` → stdio MCP servers:** docs-supported ("applied to
  every session and to subprocesses"), but in-session propagation to MCP
  servers wasn't empirically provable outside a trusted session (medium
  confidence). Tier-1 (`--as-agent` in the MCP args) doesn't depend on it;
  Tier-2 only affects ad-hoc CLI in Bash — verify during P3.
- **OpenCode `session.idle` is deprecated** upstream (in favor of
  `session.status`) though still published + documented. Follow-up: migrate the
  event handler when `session.status` is the stable surface.
- **OpenCode same-name skills across scopes** are documented as "keep unique";
  our shared-skill content is identical at both scopes, so a collision is
  benign, but watch for load warnings (P2).
- **Codex `async` hooks are parsed but skipped** — capture runs synchronously
  within the (60s) hook timeout; keep the handler fast (it already is —
  incremental import).
- **Gemini strict env redaction under GitHub Actions** drops `ME_AS_AGENT`
  from tool shells in CI contexts — irrelevant for interactive use; note in
  docs.
