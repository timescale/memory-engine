# Harness Integrations - Wave 1.5 Integration Cleanup

Status: required before starting Wave 2 provider conversion. This document
captures cross-branch findings after CI installer, harness registry/inventory,
and local-config resolver work merged to `main`.

## Scope

Fix the shared integration defects below. Do not implement provider-specific
adapter conversion, dispatcher/MCP resolver gating, `me init`, `me doctor`, or
legacy `.me/config.yaml` runtime removal in this cleanup.

## Required fixes

### 1. CI service-account denial must fail

`packages/cli/commands/project-ci.ts:356-360` catches a `FORBIDDEN` while
creating/granting a service account, prints instructions, and returns
successfully. In scripted `--create-service-account` mode this writes a workflow
but installs no secret, then reports a false success.

Required behavior:

- Print enriched admin instructions where applicable.
- Exit non-zero after the denial.
- Do not claim CI setup completed without a placed secret.

### 2. Validate CI mode before writing workflow

`packages/cli/commands/project-ci.ts:460-477` writes the workflow before
rejecting non-interactive mode without `--workflow-only` or
`--create-service-account`.

Required behavior:

- Validate all non-interactive credential-mode requirements before mutating the
  checkout.
- A rejected invocation leaves no generated/replaced workflow behind.
- Add regression coverage for this exact ordering.

### 3. Detect effective, not merely direct, space admins

`space.list().admin` is direct-admin information. The interactive CI wizard
currently uses it to choose whether to offer service-account creation, so a user
who is an effective admin through an admin group is incorrectly treated as a
non-admin.

Required behavior:

- Use an authoritative effective-admin check, or add the smallest supported
  client/RPC query needed for the wizard.
- Preserve the non-admin instructions path.
- Add direct-admin, admin-group, and non-admin coverage.

### 4. Implement aggregate/per-harness `--purge`

`packages/cli/local-config.ts` now exports `removeHarnessFromProfiles()`, but
`packages/cli/commands/install.ts` still has a deferral comment and no
`--purge` option.

Required behavior:

- Add `--purge` to aggregate `me uninstall [harness...]` and every
  `me <harness> uninstall` command.
- First uninstall recorded native artifacts. Only after the uninstall succeeds
  fully for that harness, call `removeHarnessFromProfiles(harness)`.
- Retained/modified artifacts must leave local policy untouched so a later
  retry can still find the intended state.
- Add command and local-policy cleanup tests.

### 5. Use canonical harness names in local config

`packages/cli/local-config.ts` still defines a local `HarnessName` union/list,
while `packages/cli/harness/names.ts` is now the canonical owner.

Required behavior:

- Import and use `HarnessName` and `HARNESS_NAMES` from `harness/names.ts`.
- Remove the local duplicate definitions.
- Keep parser behavior and test coverage unchanged except for the shared import.

### 6. Recover from inventory persistence failure

`packages/cli/harness/registry.ts:222-230` installs native provider state, then
writes the inventory. If inventory persistence fails, a registration can remain
without a record and `me uninstall` will not discover it.

Required behavior:

- If recording a newly installed artifact fails, attempt immediate adapter
  rollback using the artifact result.
- If rollback also fails, return a loud error that names the remaining artifact
  and the manual cleanup command/path.
- Never report success if no inventory record exists for a newly created
  registration.
- Add focused failure-path coverage.

## Explicit deferral to Wave 2

The OpenCode MCP JSON round trip does not yet preserve a config file byte for
byte after removing its `mcp.me` entry. The OpenCode Wave 2 agent owns this
because it will replace the current MCP-only mutation with the full dormant
plugin/hook artifact model. Its assignment must preserve unrelated JSON fields
and avoid leaving a newly-created empty `mcp` object.

## Explicit later waves

Do not address these here:

- Provider hook/plugin installation and dormant runtime behavior.
- MCP `tools/list` local-profile gating.
- Capture-hook and harness-CLI resolver wiring.
- `me init`, `me doctor`, `.me/config.yaml` runtime removal, or `me project
  init` migration.

## Verification

- Add focused tests for every required fix.
- Run relevant CLI, registry, installations, local-config, and CI tests.
- Run `./bun run check` before handoff.
- Do not run live harness smoke tests.

## Handoff

Return commit hash, changed files, test results, and any unresolved API gap.
