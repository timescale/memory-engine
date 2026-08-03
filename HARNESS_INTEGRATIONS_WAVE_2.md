# Harness Integrations - Wave 2 Provider Execution Plan

Status: blocked until the Wave 1 registry/inventory and local-config resolver
branches have merged to a common base. This is a contributor-facing plan for
four parallel provider-adapter agents.

## Goal

Convert each provider integration to a **global dormant dispatcher**:

- Install only user-local, ME-owned native plumbing.
- Register the exact stable MCP command `me mcp`.
- Do not bake server, space, API key, cwd, tree, or project path into native
  provider config.
- Do not prompt, log in, persist capture state, provision a space, backfill
  data, inject skills/commands, or write a repository file during install.
- At runtime, perform work only if the merged `local-config.ts` resolver
  selects the provider for the relevant surface.

The behavior contract is in:

- `HARNESS_INTEGRATIONS_REQUIREMENTS.md`
- `HARNESS_INTEGRATIONS_CONTRACTS.md`

Provider agents must read both files from the merged common base. If the Wave 1
documents have not been committed, use their `me1` absolute paths only for
reference; do not copy them into provider branches.

## Prerequisites

Before starting any Wave 2 branch:

1. Merge Wave 1 Agent B's registry/inventory implementation.
2. Merge Wave 1 Agent C's local-config resolver implementation.
3. Run `./bun run check` on the combined base.
4. Confirm these APIs exist and match the frozen contract:
   - `HarnessName`, harness descriptors, typed `InstallationArtifact`, and
     inventory update/removal helpers.
   - `resolveMcpProfile(cwd)`, `resolveCaptureProfile(cwd)`, and
     `resolveHarnessCliProfile(cwd, harness)`.
   - The no-inheritance semantics and user-CLI boundary.

Do not begin provider conversion against a guessed or locally redefined API.
If Wave 1 names differ from the frozen contract, resolve that conflict before
fan-out rather than making each adapter compensate independently.

## Checkout assignments

| Checkout | Agent | Provider |
| --- | --- | --- |
| `/Users/john/projects/me0` | Agent D | Claude Code |
| `/Users/john/projects/me1` | Agent E | OpenCode |
| `/Users/john/projects/me2` | Agent F | Codex CLI |
| `/Users/john/projects/me3` | Agent G | Gemini CLI |

Each agent creates a provider-only branch from the same merged Wave 1 base.
Each agent edits only its provider files plus its tests/docs. Do not modify
shared registry, inventory, local-config types, `credentials.ts` human CLI
resolution, or another provider's adapter.

## Shared runtime rules

### Installation

- `me <harness> install` and `me install <harness>` are mechanical and
  non-interactive.
- Installation may fail if the required harness binary/native operation fails;
  it must not ask configuration questions as a fallback.
- The adapter returns every artifact it creates using the frozen typed
  inventory union. It must not mutate an unrepresentable artifact.
- Installation is idempotent. Reinstall may refresh ME-owned generated assets
  and its own native registration, but must preserve unrelated provider config.
- Uninstall reads only the installation record and performs exact artifact
  removal. It must preserve modified ME-generated files and unrelated config.

### MCP

- Native configuration launches exactly `me mcp`.
- This wave owns only native MCP registration. The next shared dispatcher wave
  owns `local-config.ts` resolution before `tools/list`, zero-tool inactive
  behavior, and resolved `mcp.server` / `mcp.space` runtime targeting.
- Provider adapters must not reintroduce a static server, space, credential,
  cwd, or project argument while waiting for that shared gate.
- Server and credential resolution must happen at runtime, never installation.

### Capture and harness CLI

- Capture hooks call `resolveCaptureProfile` using their provider project
  anchor. Disabled or unselected capture exits successfully without a network
  call, import, or memory write.
- Harness shell commands receive only the frozen contract (`AI_AGENT`,
  `ME_PROJECT_DIR`). No credential, server, space, tree, or active-mode state
  is injected.
- The provider uses registry `HarnessName` values exactly. In particular,
  Gemini emits `AI_AGENT=gemini`, not `gemini-cli`.
- A harness-initiated `me` command can use `cli` profile targeting only after
  it confirms that known `AI_AGENT`; otherwise it follows normal human CLI
  resolution.

### Explicitly forbidden global behavior

- No global capture opt-in.
- No transcript/session backfill from an install command.
- No global memory-recall command, skill, prompt, or compaction nudge that
  appears/acts while the local profile is inactive.
- No project-scope install option and no provider config written under a
  checkout.
- No installer-time mutation of `default_server`, active space, credentials,
  or `config.yaml` policy.

## Provider assignment: Claude Code

### Owns

- `packages/cli/commands/claude.ts`
- `packages/cli/claude/**`
- `packages/claude-plugin/**`
- Claude-specific tests and `docs/cli/me-claude.md`

### Required conversion

- Replace plugin MCP configuration with exact `me mcp`; remove plugin
  substitution arguments for server, API key, and space.
- Make the user-scoped plugin/hook installation mechanical. Remove capture
  prompt, capture backfill, active-space/default-server writes, and headless
  credential branching from the install path.
- Make capture hooks resolve the local `capture` profile and no-op when
  disabled or Claude is unselected.
- Ensure plugin/hook assets do not inject Memory Engine instructions when local
  MCP/capture policy is inactive. Shared MCP zero-tool behavior is the next
  wave's responsibility.
- Return/record the exact `plugin` or `mcp-cli` artifacts required for the
  selected installation mode. Do not blindly remove a marketplace on uninstall.
- Preserve Claude's documented `CLAUDE_PROJECT_DIR` availability for the later
  shared MCP dispatcher. Do not add provider-specific resolver logic in this
  branch. Test plugin command/config generation; live worktree behavior remains
  a manual validation item.

### Claude-specific risk

The full plugin may contain slash-command, instruction, and hook assets beyond
MCP/capture. Audit all of them: an asset that automatically changes agent
behavior while a profile is inactive must be removed or made dormant.

## Provider assignment: OpenCode

### Owns

- `packages/cli/commands/opencode.ts`
- `packages/cli/opencode/**`
- OpenCode-specific tests and `docs/cli/me-opencode.md`

### Required conversion

- Force user-global installation; remove project scope and all writes to
  `<checkout>/opencode.json` and `<checkout>/.opencode/**`.
- Register the global `mcp.me` JSON entry using exact command `['me', 'mcp']`.
- Make the generated plugin resolve `capture` policy from the session
  `directory`; no-op without a selected OpenCode capture profile.
- Preserve `shell.env` only for the two frozen contract variables.
- Remove globally active recall command/skill installation and the unconditional
  compaction recall message. Do not replace them with another always-on prompt.
- Return `mcp-json` plus any remaining generated `file` artifacts with SHA-256
  records; uninstall must preserve modified user files.

### OpenCode-specific risk

MCP child cwd/context is unverified. Implement the shared fallback; do not
claim per-directory MCP routing is guaranteed until manual validation runs.

## Provider assignment: Codex CLI

### Owns

- `packages/cli/commands/codex.ts`
- `packages/cli/codex/**`
- Codex-specific tests and `docs/cli/me-codex.md`

### Required conversion

- Register exact `me mcp` with Codex.
- Keep the user-global `PreToolUse` Bash hook as dormant plumbing, returning
  only the frozen shell contract on recognized payloads.
- Preserve fail-open behavior for malformed/unknown hook payloads and sanitized
  shape logging. Do not turn hook failures into command failures.
- Return `mcp-cli` and exact `json-hook` artifacts; uninstall removes only the
  recorded hook entry.
- Remove install-time credentials/server/space resolution and any prompt.
- Document the one-time `/hooks` approval requirement.
- Document that Desktop and VS Code have unreliable MCP cwd and therefore use
  `defaults` unless the user configures native per-server `cwd`.

### Codex-specific risk

Do not automate or bypass `/hooks` trust approval. Do not run a live Codex smoke
test without explicit user approval.

## Provider assignment: Gemini CLI

### Owns

- `packages/cli/commands/gemini.ts`
- `packages/cli/gemini/**`
- Gemini-specific tests and `docs/cli/me-gemini.md`

### Required conversion

- Force user-global installation; remove project scope and all checkout writes.
- Register exact `me mcp`.
- Keep the user-global `BeforeTool` hook as dormant plumbing, returning only
  the frozen shell contract for `run_shell_command` payloads.
- Emit `AI_AGENT=gemini`.
- Preserve fail-open unknown-payload handling and sanitized shape logging.
- Return `mcp-cli` and exact `json-hook` artifacts; uninstall must preserve
  unrelated settings and hook entries.
- Remove install-time credentials/server/space resolution and any prompt.

### Gemini-specific risk

MCP cwd/context is unverified and Gemini live smoke coverage is currently
scaffolded only. Implement shared defaults fallback; do not claim per-directory
MCP behavior is guaranteed before manual validation.

## Tests required from every provider agent

- Installation command produces only the expected provider-native changes and
  records the correct typed artifacts.
- Reinstall is idempotent.
- Uninstall removes only ME-owned recorded artifacts; modified generated files
  remain intact.
- Native MCP command is exactly `me mcp`.
- Install has no configuration prompts, key/session persistence, capture
  backfill, or project-scope writes.
- Hook/plugin runtime does not write memory or inject an active prompt when the
  provider is disabled/unselected.
- Hook contract output contains the correct canonical `AI_AGENT` and project
  anchor, with no credential or policy values.
- Existing provider-specific fail-open hook behavior remains tested.

Run focused tests and `./bun run check` before commit. Do not run live smoke
tests unless the user explicitly approves them.

## Handoff requirements

Each agent returns exactly:

1. Commit hash.
2. Files changed.
3. Focused tests and `./bun run check` result.
4. Exact inventory artifacts returned by its installer.
5. Provider-specific manual validation still required.
6. Any conflict with frozen contracts, without changing them.

## Merge and integration sequence

1. Merge Claude, OpenCode, Codex, and Gemini one at a time onto the common
   Wave 1 base.
2. After each merge, run `./bun run check`.
3. Resolve only genuine overlap in command/index wiring; preserve the frozen
   shared APIs rather than letting the first merged provider become an
   accidental new contract. Shared MCP runtime wiring is the next wave.
4. After all four merge, run `./bun run check:full`.
5. Start the next wave only then:
   - Dispatcher/MCP tool gating integration and `me doctor`.
   - `me init` wizard.
   - Legacy migration, user docs, and end-to-end verification.

## Manual validation backlog

This wave must not spend model tokens on smoke tests without user approval.
After merge, validate manually:

1. Claude MCP directory context, including a worktree.
2. OpenCode global MCP child cwd/context.
3. Codex terminal MCP cwd and Desktop/VS Code documented defaults fallback.
4. Gemini global MCP child cwd/context.
5. Each provider's inactive directory after the shared dispatcher gate lands:
   connected MCP server shows zero tools; hooks no-op; no memory write occurs.
