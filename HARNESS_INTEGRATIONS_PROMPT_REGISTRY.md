# Agent Prompt - Wave 1 Harness Registry and Inventory

You are Agent C. Work only in `/Users/john/projects/me2`.

## Mission

Implement the mechanical deployment foundation from:

- `HARNESS_INTEGRATIONS_REQUIREMENTS.md`, especially sections 2.1-2.3, 3.1,
  3.5, 9, and 11.
- `HARNESS_INTEGRATIONS_CONTRACTS.md`, especially sections 1-3, 6, and 7.

These files are in your checkout and are the frozen authority. Read them before
editing.

## Scope

Create the canonical harness registry and deployment inventory:

- `packages/cli/harness/registry.ts`
- `packages/cli/harness/installations.ts`
- Focused tests for both modules.
- Top-level `me install [harness...]` and `me uninstall [harness...] [--purge]`
  command wiring.
- Mechanical per-harness command facade compatible with the registry.

Implement the frozen types and semantics exactly:

- Canonical names: `claude`, `opencode`, `codex`, `gemini`.
- `installations.yaml` v1 storage under the existing config-dir convention.
- Atomic, mode-`0600` inventory writes; invalid existing inventory fails loudly.
- Typed artifact records: `mcp-cli`, `mcp-json`, `plugin`, `file`, `json-hook`.
- Idempotent install; exact-record-only uninstall; no unrecorded discovery and
  deletion.
- File deletion only when recorded SHA-256 still matches.
- Aggregate no-argument install detects harness binaries on PATH; aggregate
  no-argument uninstall uses recorded installations.
- Per-harness install/uninstall commands are mechanical and non-interactive.
- New installs must target the stable dormant command `me mcp`, without baked
  credentials, server, space, scope, or project path.

The current provider adapters are not ready to return the new artifact records.
Add a narrow facade/adapter boundary that compiles against their current code,
but do not do the full Claude/OpenCode/Codex/Gemini behavior conversion in this
wave. Full adapter conversion belongs to Wave 2.

For `--purge`, call the local-config cleanup API from the frozen contract if it
exists after merge; do not implement local config here. If that API is not
available in this checkout, expose command wiring that can be completed in the
integration merge and document the dependency rather than duplicating config
logic.

## Existing code to inspect

- `packages/cli/mcp/install.ts`
- `packages/cli/mcp/agent-install.ts`
- `packages/cli/commands/{claude,opencode,codex,gemini}.ts`
- `packages/cli/harness-contract.ts`
- `packages/cli/credentials.ts`
- `packages/cli/index.ts`

The existing shared MCP installer bakes credentials and a server. Replace that
behavior only as needed to establish the stable installation facade; avoid
provider-specific behavioral refactors that Wave 2 agents will own.

## Explicit non-scope

Do not edit:

- `packages/cli/local-config.ts` or config resolver behavior.
- `credentials.ts` human CLI resolution.
- CI commands/workflow generator.
- `me init` wizard.
- Provider-specific capture/plugin behavior beyond the smallest adapter facade
  necessary to compile.

Do not relax the artifact ownership model or add a new artifact kind without
reporting the need.

## Verification

- Unit-test registry parsing/detection and aggregate dispatch.
- Unit-test inventory parse/write failure, atomic persistence behavior, and
  safe artifact ownership helpers.
- Run focused tests and `./bun run check` before committing.
- Do not run live harness smoke tests.

## Handoff

Commit your work. Return:

1. Commit hash.
2. Files changed.
3. Test commands/results.
4. Any temporary facade, merge dependency, deferred provider conversion, or
   contract conflict.
