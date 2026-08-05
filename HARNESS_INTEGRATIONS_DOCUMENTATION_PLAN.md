# Harness Integrations Documentation Plan

## Goal

Ship a coherent, user-facing explanation of harness installation, activation,
and configuration before the next release. The documentation must describe the
current config-first integration model without exposing Memory Engine internals.

The core message is:

1. `me install` and `me uninstall` manage user-global integration artifacts.
2. `me init` configures machine-local activation policy for a directory or
   defaults profile.
3. Harnesses use that policy at runtime; `me doctor` explains the effective
   result.
4. API keys are never written by `me`; sessions and configuration have separate
   storage.

## Source Of Truth

Before editing each page, verify its behavior against the current command help,
tests, and implementation. The public documentation must use the terminology in
`AGENTS.md`:

- A space has shared `/share` and per-member `~` roots.
- A profile is machine-local, not repository configuration.
- MCP, capture, and harness-shell CLI routing are independent profile surfaces.
- A managed MCP registration uses an identified harness and only exposes tools
  when the matched policy selects that harness.
- Environment variables and flags override machine-local settings where the
  command documents that precedence.

Do not include internal source paths, database details, implementation designs,
or unshipped behavior in `docs/`.

## New Deep Dive

Create `docs/harness-integrations.md`, titled **Harness Integrations**, and add
it to the docs-site navigation.

### Purpose

Make this page the canonical explanation of the managed harness lifecycle and
the machine-local configuration model. Other onboarding and command-reference
pages should link here rather than restating the whole model.

### Required Sections

1. **Mental model**
   - Explain the distinction between installing an integration and activating it
     for a directory.
   - State that neither action creates repository configuration.
2. **Install and uninstall**
   - Describe `me install [harness...]`, provider-specific install commands,
     and `me uninstall [harness...]`.
   - Explain managed artifact ownership: uninstall removes recorded, unchanged
     artifacts and preserves user-owned or modified configuration.
   - Give a concise harness matrix for Claude Code, OpenCode, and Codex CLI.
3. **Machine-local configuration**
   - Document the default path `~/.config/me/config.yaml`, noting that
     `XDG_CONFIG_HOME` changes the base directory.
   - Distinguish the non-secret config from session credential storage and
     environment-supplied API keys.
   - Explain `defaults` profiles, directory profiles, longest matching path,
     and complete-profile behavior.
   - Explain MCP, capture, and CLI routing surfaces with an annotated safe
     example configuration.
4. **Quick and advanced setup**
   - Explain `me init`, `me init <directory>`, `me init --verbose`, and
     `me init --defaults`.
   - Describe the quick-mode shared capture default and private-tree option.
5. **Runtime context and precedence**
   - Explain that `AI_AGENT` and `ME_PROJECT_DIR` are harness context, not
     repository configuration.
   - Describe flags and `ME_*` environment overrides at a user-facing level.
   - Separate a managed MCP process from a manually launched `me mcp` process.
6. **Verification and troubleshooting**
   - Use `me doctor`, `me status`, and provider restart/approval steps.
   - Include Codex hook approval and environment-forwarding guidance.

## Documentation Spine PR

Rewrite the three high-level pages and their immediately coupled command pages
in one focused documentation PR.

### `docs/getting-started.md`

1. Make `me init` the primary coding-agent onboarding path after installation.
2. Describe the quick setup outcome: login when necessary, space selection,
   detected harnesses, MCP and CLI routing, optional capture, and optional
   integration installation.
3. Keep `me login --device` and `ME_API_KEY` as explicit headless alternatives.
4. Replace stale capture-default language with the current shared default and
   private `~/projects/<repository>` alternative.
5. Link to Harness Integrations, Projects, and `me doctor` for next steps.

### `docs/mcp-integration.md`

1. Split managed harness setup from manual stdio MCP configuration.
2. Explain session versus API-key authentication without recommending persisted
   static secrets in client configuration.
3. Document multi-space and locked-space behavior for manual MCP servers.
4. Explain managed policy gating and link to Harness Integrations for lifecycle
   and profile details.
5. Replace obsolete installer option claims with the current dormant installer
   behavior.
6. Document Codex `env_vars` forwarding for `ME_API_KEY`, `ME_SERVER`, and
   `ME_SPACE`, including restart behavior.
7. Reduce provider-specific duplication and link to each provider reference.

### `docs/projects.md`

1. Keep the definition of a project as a tree convention, not a server object.
2. Make `me init` and the Harness Integrations page the primary route for
   per-directory capture policy.
3. Explain shared `/share/projects/<project>` and private
   `~/projects/<project>` choices without claiming one is always the default.
4. Preserve the useful shared-team, subgroup-writable, private-group, and CI
   layouts.
5. Clearly label default `team` grants as default-space conventions, not a
   universal property of every custom space.
6. Update changing-project guidance to quick/verbose `me init` flows and
   current import commands.

### Coupled CLI Pages

Update these in the same PR so the onboarding path is internally consistent:

- `docs/cli/me-init.md`
- `docs/cli/me-install.md`
- `docs/cli/me-uninstall.md`
- `docs/cli/me-mcp.md`
- `docs/cli/me-doctor.md`
- `docs/cli/me-claude.md`
- `docs/cli/me-opencode.md`
- `docs/cli/me-codex.md`

## CLI Reference Audit

Follow the spine PR with a command-by-command audit. Compare every page to
current `--help`, behavior tests, and current user-visible error paths.

### Priority Order

1. Authentication and configuration: `me-login`, `me-apikey`, `me-status`,
   `me-whoami`, `me-space`.
2. Access and lifecycle: `me-access`, `me-group`, `me-invite`, `me-service`.
3. Import and automation: `me-import`, `agent-session-imports`, `me-ci`.
4. Remaining references: memory, packs, serve, upgrade, completions.

### Audit Checklist

1. Remove retired configuration and authentication options.
2. Verify flags, positional arguments, defaults, and examples.
3. Use current principal, member, space, and tree terminology.
4. Clarify which behavior is interactive, machine-local, or safe for headless
   use.
5. Prefer links to the deep dive over duplicated harness-lifecycle explanations.

## MCP Reference Audit

Audit `docs/mcp/index.md`, `docs/mcp/agent-instructions.md`, and every tool
page against current MCP schemas.

1. Confirm tool names, required parameters, nullable parameters, and examples.
2. Verify multi-space behavior and the role of `me_space_list`.
3. Verify tree path, search mode, conflict, import, export, and access-context
   descriptions.
4. Remove stale references to retired credential or project-configuration
   models.
5. Keep examples concise and client-agnostic.

## Validation

For each documentation PR:

1. Run the CLI and MCP documentation-link tests.
2. Run docs-site navigation tests after adding the deep-dive page.
3. Run the docs-site typecheck.
4. Search for stale claims, including repository configuration, old installer
   options, private capture as an unconditional default, and retired
   organization/role terminology.
5. Review all changed documentation for the user-facing documentation rules in
   `AGENTS.md`.

## Release Order

1. Merge the quick `me init` implementation.
2. Merge the Harness Integrations deep dive and documentation spine PR.
3. Complete the CLI reference audit.
4. Complete the MCP reference audit.
5. Perform the final release documentation validation sweep.
