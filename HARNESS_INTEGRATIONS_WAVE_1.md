# Harness Integrations - Wave 1 Execution Plan

Status: ready to execute. This is a contributor-facing orchestration plan for
three parallel agents working in separate checkouts.

## Design sources

The shared requirements are currently untracked in the `me1` checkout. Until
they are committed to the common base, every agent must read these files by
absolute path before editing its own checkout:

- `/Users/john/projects/me1/HARNESS_INTEGRATIONS_REQUIREMENTS.md`
- `/Users/john/projects/me1/HARNESS_INTEGRATIONS_CONTRACTS.md`

Durable decisions are available in Memory Engine under:

- `/share/projects/memory_engine/design/harness-integrations/decisions/`
- `/share/projects/memory_engine/design/harness-integrations/implementation/`

## Goal

Complete the three independent foundations required before provider adapter
work begins:

1. Explicit, user-owned CI workflow generation.
2. Mechanical harness deployment with an uninstall-safe inventory.
3. Local harness-policy config with strict directory resolution.

No Wave 1 agent should implement a provider-specific dormant dispatcher,
`me init`, or `me doctor`. Those depend on the outputs of this wave.

## Checkout assignments

| Checkout | Branch purpose | Owner |
| --- | --- | --- |
| `/Users/john/projects/me0` | CI command/workflow rewrite | Agent A |
| `/Users/john/projects/me1` | Local config schema and resolver | Agent B |
| `/Users/john/projects/me2` | Harness registry and deployment inventory | Agent C |
| `/Users/john/projects/me3` | Reserved for integration/rebase or approved live MCP validation | None in Wave 1 |

Each agent edits and commits only in its assigned checkout. Do not copy files
between worktrees. Do not commit another agent's changes.

## Shared non-negotiables

- Use `./bun`, never bare `bun`.
- Use `apply_patch` for source edits.
- Preserve unrelated worktree changes.
- Run `./bun run check` before handoff. Run focused tests while iterating.
- Do not run harness smoke tests unless the user explicitly approves a live
  model-token-spending invocation.
- Do not implement compatibility shims beyond the requirements' explicit
  two-release redirects/migration behavior.
- Do not re-open frozen contracts. Report a conflict or missing artifact type
  instead of silently changing `HARNESS_INTEGRATIONS_CONTRACTS.md`.

## Agent A: CI rewrite

Prompt file: `HARNESS_INTEGRATIONS_PROMPT_CI.md`

Deliverable:

- `me ci install` implementation and test coverage.
- Explicit generated GitHub Actions workflow.
- Retirement/redirect of `me import ci` and `me project ci` as specified.
- Matching user documentation and navigation updates.

Must not touch:

- `packages/cli/harness/**`
- `packages/cli/local-config.ts`
- Harness provider adapters or `me init`.

Merge independence: can land at any time.

## Agent B: Registry and inventory

Prompt file: `HARNESS_INTEGRATIONS_PROMPT_REGISTRY.md`

Deliverable:

- `packages/cli/harness/registry.ts`.
- `packages/cli/harness/installations.ts`.
- Top-level aggregate `me install` / `me uninstall` command wiring.
- Mechanical per-harness facade that records typed artifacts but does not yet
  refactor each provider adapter.

Must not touch:

- `packages/cli/local-config.ts` implementation.
- CI command/workflow files.
- Provider adapter internals beyond the minimal exported facade needed to
  compile the registry. Full provider conversions are Wave 2.

Merge dependency: needed before Wave 2 provider agents and `me init`.

## Agent C: Local config and resolver

Prompt file: `HARNESS_INTEGRATIONS_PROMPT_LOCAL_CONFIG.md`

Deliverable:

- `packages/cli/local-config.ts` with frozen schema, parser, validation,
  canonical path resolution, writer API, and cleanup API.
- Safe coexistence with existing human CLI keys in `config.yaml`.
- Migration of current global capture/tree-root fields into harness defaults on
  first write.
- Focused resolver and migration tests.

Must not touch:

- Provider adapter internals.
- CI command/workflow files.
- Generic user CLI targeting in `credentials.ts`; it must remain flags -> env
  -> `me use` -> `default_server`.

Merge dependency: needed before dispatcher runtime, `me init`, and provider
adapter activation gates.

## Handoff requirements

Each agent returns exactly:

1. Commit hash.
2. Files changed.
3. Focused tests and `./bun run check` result.
4. Any intentionally deferred work.
5. Any conflict with the frozen contracts, without changing them.

## Merge order

1. Merge Agent A whenever ready.
2. Merge Agent B and Agent C, resolving only integration-level command/index
   overlap if any.
3. Rebase all Wave 2 provider branches on the merged B+C result.
4. Run `./bun run check` after each merge and `./bun run check:full` after the
   final Wave 2/provider, `me init`, and documentation integration work.

## Known validation constraints

- Claude has documented MCP-side project context through
  `CLAUDE_PROJECT_DIR`.
- Codex Desktop and VS Code launch the MCP process with an unreliable cwd;
  their per-directory MCP behavior must fall back to `defaults` unless the
  user configures provider `cwd`.
- OpenCode, Codex terminal, and Gemini MCP cwd behavior require later manual
  validation. Implement the frozen fallback now; do not claim a guarantee.
- Hook/capture and harness-shell CLI routing are unaffected because their
  provider hooks carry a project-directory anchor.
