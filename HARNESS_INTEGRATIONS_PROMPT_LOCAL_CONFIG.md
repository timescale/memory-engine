# Agent Prompt - Wave 1 Local Config and Resolver

You are Agent B. Work only in your assigned checkout.

## Mission

Implement the local harness-policy config foundation from:

- `HARNESS_INTEGRATIONS_REQUIREMENTS.md`, especially
  sections 1, 3, 4, 7, 9, 10, and 11.
- `HARNESS_INTEGRATIONS_CONTRACTS.md`, especially
  sections 1, 4, 5, 6, and 7.

Read both files before editing. They are frozen design authority.

## Scope

Create `packages/cli/local-config.ts` and focused tests implementing:

- Harness-policy schema: `version`, `defaults`, and `directories`.
- Surface types and validation for `mcp`, `capture`, and harness-only `cli`.
- Canonical absolute path handling.
- Segment-aware longest-ancestor directory matching.
- Strict no-inheritance: a matching directory profile replaces `defaults`
  wholesale; missing surface/harness means disabled.
- `resolveHarnessProfile`, `resolveMcpProfile`, `resolveCaptureProfile`, and
  `resolveHarnessCliProfile` exactly as frozen in the contract.
- Writer API: `readLocalConfig`, `writeDefaults`, `writeDirectoryProfile`, and
  `removeHarnessFromProfiles`.
- Writers preserve existing human-CLI keys in the same `config.yaml`:
  `default_server`, `servers.*.active_space`, and `server_whitelist`.
- First-write migration of current top-level global `capture` / `tree_root`
  fields into `defaults.capture`.

The purpose is local policy for the dispatcher and harness-initiated CLI only.

## Critical boundary

Never retarget a user-initiated `me` command from cwd/profile state.

- Do not add a general `resolveCliProfile(cwd)`.
- Do not change normal human CLI precedence in `credentials.ts`:
  explicit flags -> `ME_*` env -> `me use` active space -> `default_server`.
- `resolveHarnessCliProfile(cwd, harness)` is called only after the caller has
  confirmed a known `AI_AGENT`; when it returns disabled, its caller falls back
  to normal human CLI resolution.

You may make the smallest necessary `credentials.ts` changes to expose safe
config-dir/path primitives or preserve fields, but do not alter its user-CLI
resolution behavior.

## Validation detail

- Enabled MCP/capture must select at least one known harness and have a server.
- Capture requires a space. `defaults.capture` uses `tree_root`; directory
  capture uses `tree`; they are mutually exclusive.
- Selected `cli` requires a server and at least one harness; `space` is
  optional and there is no CLI tree field.
- Unknown harness names/profile keys fail loudly.
- Preserve unrelated top-level config keys during writes.
- Missing/disabled surfaces need not have their optional fields.

## Explicit non-scope

Do not edit:

- Provider installers/adapters.
- `packages/cli/harness/**` registry/inventory implementation.
- CI command/workflow files.
- `me init` UI/wizard.
- MCP server/tool registration behavior.

Do not change the frozen type/API names without reporting a genuine blocker.

## Verification

Cover at minimum:

- Canonicalization, including symlink and lexical non-existent path handling.
- Segment-aware matching (`/a/foo` must not match `/a/foobar`).
- Directory profile replaces defaults, including missing-surface disablement.
- Per-harness enablement gate for all three surfaces.
- Capture tree/tree-root scope validation.
- Writer preservation of human CLI keys and legacy field migration.
- Harness CLI enabled/disabled result semantics.

Run focused tests and `./bun run check` before committing. Do not run live
harness smoke tests.

## Handoff

Commit your work. Return:

1. Commit hash.
2. Files changed.
3. Test commands/results.
4. Any migration edge case, integration dependency, or contract conflict.
