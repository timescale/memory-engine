# Execution plan: clean-slate harness integrations

**Design:** `HARNESS_INTEGRATION_DESIGN.md` (4 harnesses × 2 scopes; user =
human, project = agent via `X-Me-As-Agent`).
**Ticket:** TNT-174. **Branch:** off `jgpruitt/as-agent` (PR 127 — provides
`--as-agent` / `ME_AS_AGENT` / `X-Me-As-Agent` + the `.me` sentinel).
**Mode:** single agent session, sequential phases, **stacked PRs** (one per
phase group). Explore subagents used only for the P0 verification research
(read-only, parallel).

## Coordination boundary (agreed)

- **Mat / TNT-168** owns the **init provisioning wizard**: creating/granting the
  agent, public/private + capture-tree prompts, **writing `.me/config.yaml`**.
- **We (this plan)** own the **wiring + step engine**: the install/init scope
  split, the shared init-step engine restructure, all asset installers, and the
  agent-mode wiring. Our `init` **fails fast** when `.me/config.yaml` has no
  `agent:` and points at the wizard — it never writes `.me/` itself.
- Interface contract to keep stable for Mat: the `InitStep` /
  `buildInitCommand` API in `packages/cli/agent/init.ts` (his wizard steps plug
  in as leading steps of `init`). Flag any signature change to him.

## Phase overview

| Phase | Deliverable | PR |
|---|---|---|
| P0 | §8 verification findings (no code) | — (notes into the design doc) |
| P1 | Shared foundation | PR 1 |
| P2 | OpenCode (pattern proof) | PR 2 |
| P3 | Claude (plugin → direct writes) | PR 3 |
| P4 | Codex | PR 4 |
| P5 | Gemini (incl. new importer) | PR 5 |
| P6 | Docs + e2e sweep | PR 6 (or folded into 2–5) |

Each phase ends green: `./bun run check` while iterating; `./bun run check:full`
before each PR (local `me-postgres`; `docker start me-postgres || ./bun run
pg:docker`). New conditional skips must include `!process.env.TEST_CI`.

---

## P0 — Verification (parallel explore subagents, read-only) — ✅ DONE 2026-07-01

All items resolved; findings folded into `HARNESS_INTEGRATION_DESIGN.md`
(§2–§5 amended; §8 is now the verification log + residual risks). Notable
design changes out of P0: Codex skills live at `.agents/skills/` (shared with
Gemini/OpenCode — one write serves three harnesses); Codex prompts are
deprecated → recall ships as a skill there; Codex capture event is `Stop`
(no SessionEnd); Gemini hooks capture on `AfterAgent` + best-effort
`SessionEnd`, with `transcript_path` in the payload; Claude does NOT read
AGENTS.md (bridge = `@AGENTS.md` import); hooks/plugins MERGE across scopes on
Claude/Codex/OpenCode → new `--scope user|project` flag on `me <h> hook` with
artifact-presence deferral (dedup, design §5).

Original scope (for reference):

1. **Codex:** `features.hooks` config shape + event names + payload (which field
   carries the rollout/transcript path); project `.codex/prompts/` and skills
   dir existence; `.codex/config.toml` trust-gating UX.
2. **Gemini:** hooks settings key + event names/payload; session storage
   location/format (feeds the P5 importer); skills dir vs `GEMINI.md` fallback;
   `contextFileName` behavior.
3. **Claude:** `claude mcp add --scope project` writes `.mcp.json` with args
   preserved verbatim (leading `--as-agent .me` intact); hooks + `env` merge
   semantics of `.claude/settings.json` vs `settings.local.json`.
4. **OpenCode:** `shell.env` plugin hook name/signature in the current plugin
   API; project `opencode.json` + `.opencode/` discovery/precedence.
5. **All:** MCP-server working directory = project root? (Else authored commands
   need `--config-dir`.)

**Exit:** §8 items resolved or explicitly downgraded to a documented fallback
(e.g. Gemini skill → `GEMINI.md` managed block).

## P1 — Foundation (PR 1) — ✅ DONE 2026-07-01

All shared machinery landed; no per-harness behavior change yet. What shipped:
`agent/managed.ts` (marker-block engine: markdown/hash markers, upsert/remove +
file wrappers, managed whole-files, managed JSON), `agent/assets.ts` (canonical
skill / recall command + recall skill / context snippets incl. the Claude
`@AGENTS.md` bridge), `agent/capture.ts` (shared hook runner: `--scope` dedup
via artifact-presence deferral, `.me`-pinned credential routing, best-effort),
`buildMeCommand` (as-agent prefix, everything opt-in), `resolveInstallPins`
(§5 pin rules), `requireProjectAgent` (init fail-fast), git-hook `asAgent`
variant. All unit-tested.

**Two scoping deviations from the original P1 list** (deliberate):
1. The install/init **command-surface** scope split (dropping `--scope` flags)
   moves into each harness's phase (P2–P5) — the split is meaningless until
   that harness's installers are rewritten, and doing it in P1 would have
   rewritten all four command files inside the foundation PR.
2. `opencode/assets.ts` and `agent/memory-pointer.ts` remain in place for the
   current commands; P2/P3 switch their harnesses onto `agent/assets.ts` and
   delete them. (The context snippet in `agent/assets.ts` IS the generalized
   memory pointer.)

1. **`buildMeCommand`** (`packages/cli/mcp/install.ts`): add `asAgent?: string`
   → emits `["me", "--as-agent", asAgent, "mcp", ...]`; keep `server`/`space`
   as opt-in pins (§5 pin rules: `--space` implies `--server`, pinned as a
   pair).
2. **Scope split:** `install` = user-scope only, `init` = project-scope only.
   Remove `--scope` from all install/init commands; `install` gains
   `--server`/`--space` pin flags + install-time session validation for the
   pinned server; `init` gains the fail-fast `.me` `agent` precondition.
3. **Managed-merge helpers** (new `packages/cli/agent/managed.ts` or similar):
   - JSON deep-merge upsert of owned keys (Claude settings, opencode.json).
   - TOML managed merge (Codex config.toml).
   - env-file managed block (`.gemini/.env`).
   - marker-block upsert for text files (generalize the git-hook/pointer
     discipline already in `import-git-hook.ts` / `memory-pointer.ts`).
   All idempotent, all reversible (`--remove`).
4. **Canonical asset sources + renderer interface** (new
   `packages/cli/agent/assets/`): skill, recall command, context snippet
   (user + project variants, project templated from `.me/config.yaml`),
   capture-plugin/hook templates. Move the OpenCode-only assets
   (`packages/cli/opencode/assets.ts`) into it.
5. **Memory pointer generalization** (`agent/memory-pointer.ts`): user-scope
   targets; harness-agnostic shared markers for the project `AGENTS.md` block
   (no harness name in markers).
6. **Hook-handler contract:** extract the shared shape of `me <h> hook`
   (read event → resolve config via `.me`-aware credentials →
   `importTranscriptFile`, best-effort exit 0) so Codex/Gemini handlers are
   thin adapters.
7. **Git hook:** `buildHookBlock` gains as-agent (project variant:
   `me --as-agent .me import git`).
8. **Init-step engine:** whatever restructuring `buildInitCommand` needs for
   the scope split — **keep the `InitStep` API stable for Mat (TNT-168)**;
   coordinate if it must change.

**Tests:** unit tests for every helper (merge idempotency + `--remove`
round-trip; `buildMeCommand` as-agent/pin permutations; pointer variants +
shared markers; pin validation). Existing suites updated for the scope split.

**Exit:** `check:full` green; no harness behavior regressed (existing installs
still work through the new plumbing).

## P2 — OpenCode (PR 2) — ✅ DONE 2026-07-01

Proves the 8-cell pattern end-to-end. `me opencode install` is now a
user-scope multi-asset installer (MCP + capture plugin + skill + /memory-recall
+ user `AGENTS.md` snippet, `--server`/`--space` pins, `--remove`), and
`me opencode init` is project-scope only (drops `--scope`; `requireProjectAgent`
fail-fast; bakes `--as-agent .me` into MCP + hook + git hook; the generated
plugin adds `--scope project` + a `shell.env` injecting `ME_AS_AGENT=.me`). The
hook command is a thin adapter over `agent/capture.runCaptureHook` with the
project-plugin dedup detector. Retired `opencode/{assets,capture}.ts`; the
plugin template gained a `scope`. Smoke-tested: fail-fast + full project wiring
(opencode.json, plugin, skill, command, AGENTS.md) verified.

Original scope (for reference):

1. `me opencode install` (user): MCP (`~/.config/opencode/opencode.json`),
   capture plugin, skill, command, user context snippet
   (`~/.config/opencode/AGENTS.md`). No as-agent, no env injection.
2. `me opencode init` (project): MCP in repo `opencode.json`
   (`me --as-agent .me mcp`), capture plugin in `.opencode/plugins/` with
   `--as-agent .me` hook commands **+ `shell.env` → `ME_AS_AGENT=.me`**, skill,
   command, project context snippet (repo `AGENTS.md`), git hook, backfills.
   Fail-fast precondition.
3. `--remove` on both.

**Tests:** plugin-template (as-agent + shell.env + injection safety), installer
unit tests, init-step wiring.

## P3 — Claude (PR 3) — plugin retirement — ✅ DONE 2026-07-01

Retired the marketplace plugin; Claude is now direct-write like the others.
`me claude install` (user scope): `claude mcp add --scope user`, capture hooks
in `~/.claude/settings.json`, skill + /memory-recall in `~/.claude/`, user
pointer in `~/.claude/CLAUDE.md`, `--server`/`--space` pins, `--remove`.
`me claude init` (project scope): `requireProjectAgent` fail-fast; `claude mcp
add --scope project` (→ `.mcp.json` with `--as-agent .me mcp`), hooks +
`env.ME_AS_AGENT=.me` in `.claude/settings.json` (scoped `me --as-agent .me
claude hook --scope project`), skill + command in `.claude/`, git hook
(`--as-agent .me`), backfills, and the CLAUDE.md pointer — using the `@AGENTS.md`
import bridge when a shared AGENTS.md block already exists. New
`claude/settings.ts` does the hook/env JSON merge (pure + tested). Deleted
`packages/claude-plugin`, `.claude-plugin/marketplace.json`,
`claude/capture.ts`, and `agent/memory-pointer.ts` (now fully unused — OpenCode
+ Claude both migrated onto `agent/assets.ts`). Smoke-tested: fail-fast, full
project wiring, and the @AGENTS.md bridge.

**Migration note for existing users:** run `claude plugin uninstall
memory-engine@memory-engine` (the old marketplace plugin) once; then
`me claude install` / `me claude init`. (A future polish could detect + warn.)

Original scope (for reference):

1. Replace plugin install with direct writes per design §3.1:
   `claude mcp add --scope user|project`, hooks + (project) `env.ME_AS_AGENT`
   via managed JSON merge into `~/.claude/settings.json` / `.claude/settings.json`,
   skill + command dirs, CLAUDE.md snippets, git hook + backfills (project).
2. **Retire `packages/claude-plugin`** (delete, or demote to an explicitly
   unmaintained optional wrapper — decide in the PR; call it out loudly in the
   description). Remove marketplace install paths (`runClaudePluginInstall`,
   `--dev`, `--mcp-only`).
3. Migration note: uninstall guidance for existing plugin users
   (`claude plugin uninstall`), printed by the new `install`/`init` when it
   detects the plugin.

## P4 — Codex (PR 4) — ✅ DONE 2026-07-01

`me codex install` (user) + new `me codex init` (project), direct-write. MCP +
(project) `[shell_environment_policy]` live in a managed TOML block in
`config.toml`; capture hooks in `hooks.json` (Codex's turn event is `Stop`,
timeout seconds); the memory-engine + memory-recall **skills** go in the shared
`.agents/skills/` (prompts are deprecated → recall is a skill); the memory
pointer in `~/.codex/AGENTS.md` (user) / repo `AGENTS.md` (project). Exposed
`parseFile` on the codex importer (the existing `parseSessionFile`) for the
capture runner; `me codex hook` reads the event from stdin. New `codex/config.ts`
(TOML block render + hooks.json merge, pure + tested). init prints the trust +
`/hooks`-approval reminder. **Also reconciled OpenCode's skill onto the shared
`.agents/skills/`** (was `.opencode/skills/`) so OpenCode + Codex + Gemini share
one copy and no harness sees a duplicate skill name. Smoke-tested end to end.

Known limitation: the TOML block appends `[shell_environment_policy]`; if the
user already defines their own top-level `[shell_environment_policy]`, TOML
forbids the duplicate table (rare — documented).

Original scope (for reference):

1. New `me codex hook` handler (thin adapter on the P1 contract) per P0
   findings.
2. Installers: `[mcp_servers.me]` + hooks (+ project
   `[shell_environment_policy]`) via TOML managed merge into
   `~/.codex/config.toml` / `.codex/config.toml`; skill + prompt; AGENTS.md
   snippets; git hook + backfills (project). Trust-gating note printed by init.
3. `me codex init` is net-new (Codex had no init).

## P5 — Gemini (PR 5) — biggest lift

1. **New importer** `packages/cli/importers/gemini.ts` (+ `me import gemini`,
   registered in the import group) per P0 storage findings.
2. New `me gemini hook` handler.
3. Installers: `gemini mcp add --scope user|project`; hooks in settings.json;
   project `.gemini/.env` (`ME_AS_AGENT=.me`) managed block; skill (or
   GEMINI.md fallback per P0); command TOML; GEMINI.md snippets; git hook +
   backfills (project). `me gemini init` is net-new.

## P6 — Docs + e2e (PR 6, or folded into P2–P5)

1. Rewrite `docs/cli/me-claude|opencode|codex|gemini.md`,
   `docs/mcp-integration.md`, `docs/project-config.md` around the
   install/init × human/agent matrix (+ pin flags, precedence gotcha,
   built-in-terminal wrinkle).
2. e2e (`e2e/cli.e2e.test.ts`): extend the act-as-agent block — project-scope
   style capture/import writes as the `.me` agent; user-scope writes as the
   human; pinned install honors the pin.
3. Update `AGENTS.md` (repo) CLI command list if command surfaces changed.

---

## Working agreements

- **Stacked PRs** in phase order; each rebases on the previous. PR 1 is the
  only one that touches shared files broadly — review it hardest.
- Prefer folding a phase's doc updates into its PR (P6 then shrinks to the
  cross-cutting pages + e2e).
- Anything discovered in P0 that changes the design gets amended in
  `HARNESS_INTEGRATION_DESIGN.md` *first*, then implemented.
- `TNT-174-PLAN.md` is superseded by the design doc + this plan (delete it in
  PR 1).
