# `me init` Wizard Plan

## Decision

When `me init` runs on a TTY with surface flags but no scope, it prompts only
for scope. The supplied flags remain the complete deterministic profile input;
the command does not enter the interactive surface wizard.

## Scope

Implement the machine-local `me init` wizard described in
`HARNESS_INTEGRATIONS_REQUIREMENTS.md`.

1. Preserve explicit noninteractive flag behavior and validation.
2. Prompt for directory versus `--defaults` scope whenever no scope is supplied
   on a TTY. When surface flags are present, this is the only prompt.
3. Build complete profiles with explicitly disabled MCP, capture, and harness
   CLI surfaces, then write once after confirmation.
4. Add login/device-flow selection, zero-space personal-space bootstrap, and
   optional installation for detected, uninstalled Claude, OpenCode, and Codex
   integrations.
5. Configure MCP, capture, and harness-only CLI routing independently.
6. Keep all harness policy machine-local; never write repository configuration.

## Implementation Order

1. Refactor `packages/cli/commands/init.ts` into reusable profile-building and
   scope-validation helpers. Retain current flag errors while serializing
   disabled surfaces explicitly.
2. Extract only the login/bootstrap primitives required by the wizard from
   `commands/login.ts`; do not invoke Commander recursively.
3. Add wizard dependencies for prompts, credentials, user-space discovery, and
   harness registry operations so unit tests can inject them.
4. Implement scope/replacement, auth/bootstrap, optional install, MCP,
   capture, CLI, confirmation, and one final config write in that order.
5. Extend command tests for all cancellation, validation, profile, and
   installation cases. Preserve local-config resolver tests as the authority
   for canonical paths and no inheritance.
6. Update `docs/cli/me-init.md` and onboarding guidance, then run
   `./bun run check:full`.

## Constraints

- Only Claude, OpenCode, and Codex are selectable harnesses.
- Capture uses `tree` for directory profiles and `tree_root` for defaults.
- The CLI surface affects only commands invoked under a selected harness
  contract, never ordinary user CLI commands.
- Existing profiles require explicit replacement confirmation.
- A zero-space user may create only a personal default space through
  `user.space.ensureDefault()`; ordinary pickers never create spaces.
