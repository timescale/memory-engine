# Harness Integrations - Wave 2 Integration Findings

Status: provider/registry integration completed locally and verified with
`./bun run check`. Shared runtime policy gating remains a later wave.

## Blocking Findings

### 1. Provider adapters were not wired into the registry

`packages/cli/harness/registry.ts` still gives every harness the generic
MCP-only descriptor. Consequently both `me install <harness>` and
`me <harness> install` omit provider hooks, plugins, generated files, and their
inventory artifacts.

Resolution:

- Each registry descriptor now dispatches to its provider adapter.
- The registry persists the returned complete artifact set.
- Aggregate and per-harness commands share this descriptor path.

### 2. Provider artifact ownership was incomplete

Adapters must return a complete post-install owned artifact set on every
successful install/reinstall. Uninstall must remove only recorded artifacts and
return exact `removed` and `retained` lists.

Resolution:

- Claude rolls back marketplace creation when plugin installation fails.
- OpenCode preserves malformed `mcp` config, retains complete artifacts on
  reinstall, and cleans up partial plugin writes.
- Codex avoids claiming unchanged hooks and reports complete uninstall results.
- Gemini honors recorded hook values and preserves existing owned artifacts.
- Shared hook mutation rejects malformed nested structures.

### 3. Legacy OpenCode install behavior was reachable

The project-init compatibility flow now delegates to `installHarness("opencode")`.
The obsolete project-scoped plugin, recall command, skill, prompt, and backfill
installer code has been removed.

### 4. Dormant runtime remains a later shared step

MCP policy gating (`tools/list: []`), capture policy gating, and harness CLI
routing are not yet wired. This is intentionally deferred, but provider assets
must not add globally active recall/skill/prompt behavior while waiting.

### 5. Documentation had to match the installed surface

Provider command documentation now describes the recorded provider artifacts,
including Claude's plugin, OpenCode's generated plugin, and Codex/Gemini hooks.

## Completion Criteria

- Public aggregate and per-harness install/uninstall commands call the same
  adapter path.
- Every native artifact created by public install is recorded in
  `installations.yaml`.
- Public uninstall removes each recorded artifact safely and preserves changed
  user state.
- No reachable install command prompts, backfills, or writes provider/project
  configuration under a checkout.
- Focused adapter and registry tests cover every harness and artifact inventory.
- `./bun run check` passes.
