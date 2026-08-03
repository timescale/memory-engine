# Agent Prompt - Wave 1.5 Integration Cleanup

Work in your assigned checkout, rebased on current `main` containing the merged
Wave 1 work.

## Mission

Fix the cross-branch integration defects in:

- `HARNESS_INTEGRATIONS_WAVE_1_5.md`
- `HARNESS_INTEGRATIONS_REQUIREMENTS.md`
- `HARNESS_INTEGRATIONS_CONTRACTS.md`

The requirements/contracts may remain untracked in `/Users/john/projects/me1`.
Read them from that absolute path if they are absent from your checkout.

## Required work

Implement all six Wave 1.5 fixes:

1. A forbidden service-account create/grant in `me ci install` must print
   enriched instructions **and exit non-zero**.
2. Validate invalid scripted CI credential modes before writing/replacing the
   workflow file.
3. Make the interactive CI wizard recognize effective space admins, including
   users who are direct space members of an admin group.
4. Wire `--purge` for aggregate and per-harness uninstall. Remove local policy
   only after the corresponding native uninstall fully succeeds.
5. Make `local-config.ts` import canonical `HarnessName` / `HARNESS_NAMES` from
   `packages/cli/harness/names.ts`.
6. Make native install + inventory persistence recoverable: rollback a newly
   created native artifact if inventory recording fails, and loudly report any
   rollback failure.

Read the detailed acceptance criteria and scope limits in
`HARNESS_INTEGRATIONS_WAVE_1_5.md`; they are part of this prompt.

## Likely files

- `packages/cli/commands/project-ci.ts`
- `packages/cli/commands/project-ci.test.ts`
- `packages/cli/commands/install.ts`
- `packages/cli/harness/registry.ts`
- `packages/cli/harness/registry.test.ts`
- `packages/cli/local-config.ts`
- `packages/cli/local-config.test.ts`
- Client/protocol code only if an effective-admin read cannot be expressed with
  existing supported APIs.

Inspect before expanding scope. Prefer an existing authoritative API over adding
a new endpoint.

## Boundaries

Do not implement:

- Provider-specific Claude/OpenCode/Codex/Gemini dormant conversion.
- OpenCode JSON cleanup changes reserved for its Wave 2 agent.
- MCP resolver/tool gating, capture hook integration, harness CLI routing.
- `me init`, `me doctor`, legacy `.me/config.yaml` removal, or project-init
  replacement.

Do not change the frozen requirements/contracts. Report a real conflict rather
than redefining shared types or artifact semantics.

## Test requirements

Add tests proving:

- Scripted invalid CI modes leave no workflow file.
- `FORBIDDEN` CI service-account setup exits non-zero after instructions.
- Direct admin, effective admin-group member, and non-admin wizard behavior.
- Successful and retained/failed uninstall behavior with `--purge`.
- Inventory-write failure invokes rollback and never reports a clean success.
- Local config consumes the registry-owned harness identifiers.

Run focused tests and then:

```sh
./bun run check
```

Do not run live harness smoke tests.

## Handoff

Commit the change and return:

1. Commit hash.
2. Files changed.
3. Test commands/results.
4. Any new API required for effective-admin detection.
5. Any remaining issue that belongs to Wave 2 or later.
