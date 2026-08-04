# Harness Integrations — Requirements

Status: **draft; superseding the current `me project init` / `me project ci` /
`me claude install` / `me opencode install` / `me codex install` design.**
Contributor-facing; not published to
`docs.memory.build/`.

This document is the implementation contract for a rework of how Memory Engine
integrates with coding-agent harnesses (Claude Code, OpenCode, Codex).
It replaces committed-repo configuration, one-command "installs everything and
turns everything on" flows, and the current project/CI split with a smaller,
sharper model:

- One dormant dispatcher globally installed per harness.
- One local file that describes what the dispatcher does per directory.
- Three commands (`me install`, `me init`, `me ci install`) that own setup
  end-to-end. Everything else is mechanical.

The decisions that back each requirement live in Memory Engine memories under
`/share/projects/memory_engine/design/harness-integrations/decisions/`; the
implementation-planning notes live under `.../implementation/`. This file is
the terse version an implementer needs.

---

## 1. Guiding principles

1. **Install ≠ enable.** Installing the dispatcher into a harness must not
   activate capture, injection, MCP tool exposure, memory writes, or context
   effects anywhere.
2. **Local individual control.** Everything that affects a developer's own
   harness lives under `~/.config/me/` on that machine. Nothing about an
   individual's harness behavior is stored in a repository.
3. **Independence of bindings.** MCP, capture, and CLI-in-harness are three
   independent surfaces. Enabling one must not enable another.
4. **Explicit scope; no inheritance.** A configured directory replaces
   `defaults` wholesale for behavior; there is no field-level fallback.
5. **CI configuration lives in the CI workflow.** The generated workflow file
   is the source of truth; `me ci install` scaffolds it once, then hands it
   over.
6. **No committed policy.** Cloning a repository must not change what Memory
   Engine does on a developer's machine.
7. **User CLI stays explicit.** A user typing `me …` at a shell is never
   silently retargeted by directory profiles. Space/server targeting for
   user CLI is controlled only by explicit flags, `ME_*` env vars, and
   `me use`. The `cli` config surface is a harness-context routing policy,
   not a general CLI profile system.

---

## 2. Command surface

### 2.1 `me install [harness...]`

- No arguments: detect every supported harness on `PATH` (Claude Code,
  OpenCode, Codex) and install the dispatcher for each.
- Arguments: install only the named harnesses. Unknown names error.
- Purely mechanical: writes only ME-owned native plumbing (hook entries, MCP
  registration, plugin/env-hook files) and updates `installations.yaml`.
- Managed MCP registrations run `me mcp --harness <name>`. The harness identity
  selects that harness's local MCP policy; no registration includes a server,
  space, credential, scope, or project path.
- **No prompts.** Never asks about auth, space, tree, capture, MCP, or data
  collection.
- Idempotent.

### 2.2 `me uninstall [harness...] [--purge]`

- Symmetric to `me install`.
- No arguments: uninstall every ME-managed integration recorded in
  `installations.yaml`.
- Removes only ME-owned entries; leaves unrelated harness config alone.
- Per-directory activations in `~/.config/me/config.yaml` are preserved by
  default. `--purge` also removes them.
- **No prompts.**

### 2.3 `me claude install` / `me opencode install` / `me codex install` (and matching `uninstall`)

- The single-harness form of `me install` / `me uninstall`.
- Mechanical; no prompts.

### 2.4 `me init [directory] [--defaults] [flags]`

- The one personal-configuration wizard.
- Writes only `~/.config/me/config.yaml`.
- `me init` on a TTY prompts for scope; off a TTY errors out.
- `me init .` / `me init <dir>` writes a directory profile.
- `me init --defaults` writes the fallback `defaults` profile.
- The positional path and `--defaults` are mutually exclusive.
- The positional path is canonicalized (absolute, symlinks resolved) before
  being written under `directories.<path>`.
- Non-interactive flags:
  - `--mcp-space <slug>`
  - `--mcp-multi-space` (conflicts with `--mcp-space`)
  - `--mcp-server <url>`
  - `--mcp-harness <name>` (repeatable)
  - `--capture-space <slug>`
  - `--capture-server <url>`
  - `--capture-tree <path>` (directory scope only)
  - `--capture-tree-root <path>` (`--defaults` scope only)
  - `--capture-harness <name>` (repeatable)
  - `--cli-space <slug>`
  - `--cli-server <url>`
  - `--cli-harness <name>` (repeatable)

  Rules:
  - Absence of any `--<surface>-*` flag means that surface is disabled.
  - A surface enabled with zero harnesses selected is a validation error at
    write time.
  - `--mcp-space` and `--mcp-multi-space` are mutually exclusive.
  - `--capture-tree` requires directory scope; `--capture-tree-root` requires
    `--defaults` scope; mixing them is an error.

### 2.5 `me ci install [flags]`

- Generates a starter GitHub Actions workflow and (optionally) provisions the
  service account + secret.
- Interactive on a TTY; also runnable non-interactively via flags.
- Refuse-or-force file semantics:
  - Workflow does not exist → create.
  - Workflow exists → refuse.
  - `--force` overwrites the workflow entirely (no merge, no marker).
- Non-interactive flags:
  - `--server <url>`
  - `--space <slug>` (required off-TTY)
  - `--tree <path>` (default `/share/projects/<repo-name>`)
  - `--secret-name <name>` (default `ME_API_KEY`)
  - `--service-account <name>` (default `<repo>-import`)
  - `--create-service-account`
  - `--workflow-only`
  - `--force`

### 2.6 Removed commands

- `me project init` — removed. Use `me init`.
- `me project ci` — removed. Use `me ci install`.
- `me import ci` — removed. The generated workflow calls `me import git` and
  `me import docs` directly.

### 2.7 Prompt policy

- Only two commands are ever interactive: `me init` and `me ci install`.
- Every other command in the install/uninstall/CI space is non-interactive.
- Neither wizard offers "Create a new space" in space pickers.
  - `me init` has one exception: when the authenticated user has **zero**
    spaces after login, it offers to create a personal space (via
    `user.space.ensureDefault()`) as the bootstrap branch.

---

## 3. Local config: `~/.config/me/`

### 3.1 Files

```
~/.config/me/
  config.yaml         # user policy (this schema)
  installations.yaml  # ME-managed deployment inventory
  credentials.yaml    # existing secret fallback (unchanged)
```

- `config.yaml` is human-editable and is what `me init` reads/writes.
- `installations.yaml` is read/written only by `me install` / `me uninstall`;
  never by the wizard, dispatcher, or user.
- `credentials.yaml` retains its current secret-fallback role.

### 3.2 `config.yaml` schema

```yaml
version: 1

# Machine-level fallback used only for out-of-profile / bootstrap CLI
# (e.g. `me login`, `me space list` when no directory profile matches).
default_server: https://api.memory.build

# Fallback profile: applies when the current directory does not match any
# entry under `directories:`.
defaults:
  mcp:
    enabled: false
    server: https://api.memory.build
    space: <slug or omitted for multi-space>
    harnesses:
      claude: false
      opencode: false
      codex: false

  capture:
    enabled: false
    server: https://api.memory.build
    space: <slug>
    tree_root: ~/projects        # defaults capture uses tree_root
    harnesses:
      claude: false
      opencode: false
      codex: false

  cli:
    server: https://api.memory.build
    space: <slug or omitted>
    harnesses:
      claude: false
      opencode: false
      codex: false

# Complete per-directory profiles. Presence of a matched entry REPLACES
# defaults wholesale for that directory.
directories:
  /Users/alice/projects/widget:
    mcp:
      enabled: true
      server: https://api.memory.build
      space: team-memory
      harnesses:
        claude: true
        opencode: true

    capture:
      enabled: true
      server: https://api.memory.build
      space: session-archive
      tree: /share/projects/me1  # directory capture uses tree
      harnesses:
        claude: true
        opencode: false

    cli:
      server: https://api.memory.build
      space: team-memory
      harnesses:
        claude: true
        opencode: true
```

### 3.3 Surfaces

Three independent top-level surface blocks per profile:

- **`mcp`** — controls MCP tool exposure to harness clients.
  - `enabled: false` → `tools/list` returns `[]`.
  - `server` — required when enabled.
  - `space` (optional) — locked-space MCP; omitted → multi-space MCP.
  - `harnesses.<name>` — per-harness allowlist.

- **`capture`** — controls transcript collection.
  - `enabled: false` → hooks no-op.
  - `server`, `space` — required when enabled.
  - Destination:
    - Directory scope profiles use `tree` (full project node, no slug append).
    - The `defaults` profile uses `tree_root` (slug-free parent; the
      runtime appends a per-project slug).
    - Mixing `tree` and `tree_root` in the same profile is an error.
  - `harnesses.<name>` — per-harness allowlist.

- **`cli`** — **harness-context-only** routing policy for Memory Engine CLI
  invocations initiated by a harness. This surface has no effect on
  user-initiated CLI use.
  - `server`, `space` (optional).
  - **No `tree` field.** CLI targeting is server + space; individual commands
    control their own tree via flags.
  - `harnesses.<name>` — per-harness allowlist.
  - Applies **only** when the invoking `me` process is running inside a
    harness shell. "Inside a harness shell" means the harness contract env
    (`AI_AGENT` set to a known harness name, injected by the dormant
    dispatcher per `harness-contract.ts`) is present. `ME_PROJECT_DIR` alone
    is not sufficient — a human running `cd $ME_PROJECT_DIR && me search foo`
    is still a user invocation.
  - When the harness contract is present and the matched profile's
    `cli.harnesses.<AI_AGENT>` is true, targeting is drawn from that
    profile's `cli` block: `server` and (if set) `space`. Missing `space`
    means the CLI behaves as multi-space (each command targets what its own
    flags / env / active-space fallback resolve to).
  - When the harness contract is present but the matched profile does **not**
    select that harness under `cli.harnesses`, the CLI falls back to normal
    user-CLI behavior (see below). This is deliberate: a harness that the
    user has not opted into for CLI routing is treated exactly like any
    other shell.
  - **User-initiated CLI use never consults `cli`, `defaults.cli`, or the
    `directories.*` map.** See section 3.4 for the full user-CLI resolution
    order.

### 3.4 Resolution

Resolution splits by **consumer**. The `mcp` and `capture` surfaces are
directory-driven for both harness and dispatcher use. The `cli` surface is
directory-driven **only** for harness-initiated CLI. User-initiated CLI uses
a separate, per-command resolution chain that never reads `directories:`,
`defaults.cli`, or `default_server` as a targeting override.

#### 3.4.1 `mcp` and `capture` (dispatcher / hooks)

Given the current working directory:

1. Canonicalize to an absolute, symlink-resolved path.
2. Find the **most-specific** ancestor (or equal) directory listed under
   `directories:`, using segment-aware longest-prefix matching. (`/a/foo` does
   not match `/a/foobar`.)
3. If a matched entry exists: that profile alone determines behavior for the
   `mcp` and `capture` surfaces.
4. Otherwise: the `defaults` profile alone determines behavior.

**No field-level inheritance.** A missing surface in a matched profile means
that surface is disabled. A missing harness under a surface's `harnesses:` map
means that harness is not selected for that surface. `defaults` is not
consulted to fill in gaps.

MCP directory propagation is provider-aware. The dispatcher first resolves
against `process.cwd()` at server start. If that finds no directory profile,
the Claude dispatcher tries `CLAUDE_PROJECT_DIR`, then every dispatcher tries
`ME_PROJECT_DIR`. A fallback is used only when the earlier location has no
directory profile, so an explicitly-disabled profile is never bypassed. If no
location matches, the handler resolves against `defaults`.

OpenCode and the Codex terminal CLI start local MCP servers from the session
directory. Claude documents `CLAUDE_PROJECT_DIR` as the reliable MCP project
signal, but it is a fallback because it can point to the main checkout for a
worktree session. Codex Desktop and the VS Code extension have no reliable
dynamic project directory for global MCP registrations; they intentionally use
the `defaults` profile unless the user configures a provider-native per-server
`cwd`. Per-directory MCP behavior is otherwise a best-effort provider feature;
`me doctor` reports which resolution path was taken.

#### 3.4.2 `cli` — harness-initiated CLI

Triggered when the `me` process starts with the harness contract present
(`AI_AGENT` set to a known harness name). Then:

1. Canonicalize the CLI's cwd. If `ME_PROJECT_DIR` is set by the dispatcher,
   canonicalize that instead — it is the discovery anchor the harness
   provides.
2. Longest-ancestor match against `directories:` (same rules as 3.4.1).
3. If a matched entry has `cli.harnesses.<AI_AGENT> === true`, target the
   command using that profile's `cli.server` and (if set) `cli.space`.
4. If no directory profile matches, and `defaults.cli.harnesses.<AI_AGENT>
   === true`, target using `defaults.cli`.
5. Otherwise — matched profile does not select this harness, or defaults do
   not — **fall back to user-CLI resolution (3.4.3).**

Once a `cli` block is selected, its `server`/`space` supply the base
targeting; per-command flags and `ME_*` env vars still override on the same
command.

#### 3.4.3 `cli` — user-initiated CLI

Triggered when the `me` process starts **without** the harness contract, or
when 3.4.2 falls through. Resolution is per-existing-CLI precedence, in
order:

1. Explicit per-command flags (`--server`, `--space`, `--api-key`, …).
2. `ME_SERVER` / `ME_SPACE` / `ME_API_KEY` / `ME_SESSION_TOKEN` from the
   environment.
3. The active space selected by `me use <slug>` (persisted in
   `~/.config/me/config.yaml` under the existing active-space key, per
   `packages/cli/credentials.ts`).
4. `default_server` for the server (login/bootstrap fallback).
5. Interactive prompt or error, per each command's existing behavior.

**User-initiated CLI never consults `directories:` or `defaults.cli` for
targeting.** Entering a configured project directory does not silently
retarget an interactive `me search`, `me create`, `me space list`, etc. The
only role `~/.config/me/config.yaml` plays for user CLI is the existing
`default_server` + `me use` active-space state.

This is the deliberate distinction: the `cli` surface exists to give a
harness a **stable, project-scoped identity** without the human having to
`me use` before every session; the human, sitting at a shell, keeps the
current explicit-selection model.

### 3.5 `installations.yaml`

The exact serialized schema and artifact ownership rules are frozen in
[`HARNESS_INTEGRATIONS_CONTRACTS.md`](HARNESS_INTEGRATIONS_CONTRACTS.md),
section 3. The short illustrative shape is:

```yaml
version: 1

installations:
  claude:
    installed_at: 2026-07-31T18:00:00Z
    me_version: <semver>
    files:
      - <absolute path or logical entry description>
  opencode:
    ...
  codex:
    ...
```

Enough detail for `me uninstall` to precisely remove what `me install`
wrote, without touching unrelated provider config. Users do not edit this file.

---

## 4. `me init` wizard

Ordered steps:

1. **Scope**
   - Skipped when `me init <dir>` or `me init --defaults` is passed.
   - TTY: prompt for "this directory" vs. "defaults."
   - Non-TTY without a scope flag: error out.
   - If the chosen scope already has a profile, prompt to replace.

2. **Login (if needed)**
   - Auto-select login flow based on best-effort browser detection.
   - Offer the alternative flow via an explicit prompt.
   - Declining exits cleanly.

3. **Bootstrap: zero-space branch**
   - Runs only when the authenticated user has zero spaces.
   - Offers a personal-space creation via `user.space.ensureDefault()`.
   - Declining exits cleanly with guidance.

4. **Integrations (if any are missing)**
   - Detect installed harnesses via `Bun.which` and their install state via
     `installations.yaml`.
   - Zero installed harnesses detected: skip step with a one-line note.
   - Exactly one uninstalled: yes/no.
   - Multiple uninstalled: multiselect.
   - Selecting invokes `me install <selected...>` inline. Declining is allowed.
   - Always call these "MCP tools" in prompts; never bare "tools."

5. **MCP surface**
   - Yes/no.
   - Harness multiselect drawn from the detected+installed set.
   - Space picker: existing spaces only; plus "Let the agent choose a space for
     each request" (which omits `space`).
   - Server prompt: default to the login-active server; allow overriding.

6. **Capture surface**
   - Yes/no.
   - Harness multiselect drawn from the detected+installed set.
   - Space picker.
   - Directory scope: prompt for `tree`.
   - `--defaults` scope: prompt for `tree_root`; also print an explicit privacy note
     that sessions from unconfigured directories will go to that (private)
     space.
   - Server prompt.

7. **CLI surface (harness-context only)**
   - Prompt copy must make the scope explicit, e.g.: "Route Memory Engine CLI
     commands **run by these harnesses** to this space? Your own `me`
     commands are not affected — they continue to use `me use` and explicit
     flags."
   - Yes/no.
   - Harness multiselect drawn from the detected+installed set.
   - Space picker; server prompt.
   - No tree prompt.
   - The wizard must not offer any prompt that would change user-CLI
     targeting; `me use` remains the mechanism for that.

8. **Confirmation + write**
   - Show the resolved profile.
   - On confirm, write the complete profile including explicitly-disabled
     surfaces (`enabled: false`, `harnesses: {}`) so the no-inheritance
     invariant reads cleanly on future inspection.

Validation rules:
- A surface `enabled: true` with no harnesses selected: refuse; loop back on
  the harness step.
- Directory scope + `tree_root`, or `--defaults` scope + `tree`: refuse.

---

## 5. `me ci install` wizard

Ordered steps:

1. **Preflight**
   - Fail unless inside a git repository with a GitHub `origin` remote.
   - Fail unless the workflow file (`.github/workflows/me-import.yml`) is
     absent or `--force` is set.

2. **Space picker**
   - Lists only spaces the user belongs to.
   - **No "create a new space" option.**
   - Zero eligible spaces: fail with guidance to `me space create` or accept
     an invitation.

3. **Tree**
   - Default `/share/projects/<repo-name>`. Editable.

4. **Secret name**
   - Default `ME_API_KEY`. Editable.

5. **Space-admin check**
   - Immediately after space selection, determine whether the caller is an
     effective admin of the space (direct admin, or a direct-member user of an
     admin group).

6. **Credential prompt (admin)**
   ```
   > I have a service account's ME_API_KEY
     Create a service account
   ```
   - **Existing-key path**: hidden-input key prompt; require usable `gh` +
     repo-secret write access; pipe key directly to
     `gh secret set <secret-name> --repo <owner/repo>`; **never** print, log,
     or persist the key. If a secret with the chosen name is already visible,
     prompt one overwrite confirmation.
   - **Create-SA path**: create `<repo>-import` with the caller in its bound
     admin group; grant write at the selected tree; mint a key; pipe directly
     into `gh secret set`. Placement failure revokes the just-minted key.

7. **Credential prompt (non-admin)**
   ```
   > I have a service account's ME_API_KEY
     Give me instructions
   ```
   - Existing-key path: same as admin.
   - Instructions path: generate the workflow, then print the exact
     `me service create` / `me access grant` / `me apikey create` /
     `gh secret set` commands, plus the selected space's admin emails.

8. **Workflow generation**
   - Path: `.github/workflows/me-import.yml`.
   - Baked env: `ME_API_KEY: ${{ secrets.<secret-name> }}`, plus `ME_SERVER`
     when the resolved server differs from what a bare CI checkout would
     resolve, plus `ME_SPACE: <selected slug>`.
   - Steps call `me import git --tree <tree>` and
     `me import docs . --git-aware --prune --tree <tree>` directly.

Validation rules:
- Not a git repo, or no GitHub `origin`: fail before prompting.
- Workflow exists without `--force`: fail before prompting.
- `--create-service-account` in scripted mode from a non-admin: server denial
  surfaces with admin contacts; the wizard renders the same instructions.

**No verification of the pasted key's identity in v1.** A wrong key surfaces
as a loud first-CI-run auth error.

---

## 6. CI generated workflow

The workflow is short, explicit, and single-target. Illustrative shape:

```yaml
name: Memory Engine import
on:
  push:
  workflow_dispatch: {}

concurrency:
  group: me-import-${{ github.ref }}
  cancel-in-progress: true

jobs:
  import:
    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - name: Install me
        run: |
          set -o pipefail
          mkdir -p "$HOME/.local/bin"
          curl -fsSL https://install.memory.build | ME_INSTALL_DIR="$HOME/.local/bin" sh
      - name: Import git history
        env:
          ME_API_KEY: ${{ secrets.ME_API_KEY }}
          ME_SPACE: team-memory
        run: "$HOME/.local/bin/me" import git --tree /share/projects/widgets
      - name: Import docs
        env:
          ME_API_KEY: ${{ secrets.ME_API_KEY }}
          ME_SPACE: team-memory
        run: "$HOME/.local/bin/me" import docs . --git-aware --prune --tree /share/projects/widgets
```

Users needing separate spaces or credentials per phase edit the YAML directly
(duplicate/rename steps; change each step's `env:`). This is the deliberate
non-goal of `me ci install`; anyone with divergent CI needs owns the workflow
after generation.

---

## 7. Legacy `.me/config.yaml`

- This is a hard cut. The runtime, capture hooks, MCP dispatcher, `me init`,
  and CLI commands do not read, write, discover, validate, or migrate
  `.me/config.yaml` or `.me/config.local.yaml`.
- `ME_CONFIG_DIR` and `--config-dir` are removed.
- Existing repository pins have no effect on behavior. Harness policy comes
  only from machine-local `~/.config/me/config.yaml` profiles, resolved from
  `ME_PROJECT_DIR` or the current working directory.

---

## 8. Hard Cut

There is no deprecation window or compatibility shim. `me project init`,
`me project ci`, `me import ci`, repository configuration, and their related
environment variables and flags are removed. Users must use the replacement
commands and machine-local configuration directly.

---

## 9. Test/acceptance criteria

The rework is complete when all of the following hold on `./bun run check:full`:

- `me install`, `me uninstall`, and the per-harness variants are exercised in
  integration tests against the three harnesses (Claude, OpenCode, Codex). No
  user prompts appear in any of these tests.
- `installations.yaml` is created/updated by `me install` and consumed by
  `me uninstall` such that a full round-trip leaves each harness's native
  config file byte-identical to its pre-install state (ignoring unrelated
  edits made by the user or provider).
- `me init` writes the schema in section 3.2, including explicitly-disabled
  surfaces. Round-tripping a written config through `me init` (or the
  non-interactive flag form) produces an identical file.
- Longest-ancestor match, no-inheritance, and canonical-path resolution are
  covered by unit tests. Symlink and `..`-traversal inputs land on the
  canonical path.
- `me ci install` refuses when the workflow exists and overwrites entirely
  with `--force`. Generated workflows are byte-identical across identical
  inputs. Piped-key placement never persists the key on disk in any code path.
- The existing invariants around service-account key handling (mint only with
  immediate placement, revoke on failed placement, admin-contact enrichment on
  denials) are preserved.
- Hooks, MCP `tools/list`, and CLI-in-harness invocations resolve their target
  surface via the config resolver and respect the no-inheritance rule.
- Integration test: a user-initiated `me` command run inside a directory that
  has a `cli` profile (with the user's own shell — no `AI_AGENT` env) ignores
  that profile and resolves targeting solely from flags / `ME_*` env /
  `me use` active space / `default_server`.
- Integration test: the same command, run with the harness contract present
  (`AI_AGENT=<harness>` injected by the dispatcher) and the profile selecting
  that harness under `cli.harnesses`, is targeted by the profile's `cli`
  block.
- Integration test: harness contract present but `cli.harnesses.<harness>`
  false → command falls back to user-CLI resolution.
- `me doctor` explains inactivity ("MCP is inactive here because the matched
  directory profile has `mcp.enabled: false`" / "Capture is inactive here
  because no matched directory profile exists and defaults disable it").
- `me project init`, `me project ci`, and `me import ci` are absent from the
  command surface.
- `packages/cli/docs-cli-links.test.ts`, `packages/cli/mcp/docs-links.test.ts`,
  and `packages/docs-site/lib/nav.test.ts` all pass with the new pages
  (`docs/cli/me-init.md`, `docs/cli/me-ci.md`, etc.) added and the retired
  pages removed.

---

## 10. Non-goals

- **No launcher/wrapper.** Users continue to invoke `claude`, `opencode`, and
  `codex` natively. Memory Engine does not shell over them.
- **No CI-side declarative policy.** `.me/policies.yaml` and `me apply` are
  not introduced.
- **No multi-target CI generator.** `me ci install` writes a single-space,
  single-tree workflow. Divergent topologies are user edits after generation.
- **No cross-file config precedence.** There is one source of truth
  (`~/.config/me/config.yaml`) and no per-field merge into `defaults`.
- **No implicit space creation** in ordinary pickers. Only the zero-space
  bootstrap branch of `me init` provisions a personal space.
- **No directory-profile override of user CLI.** A general
  "auto-`me use` on `cd`" behavior driven by `directories:` is explicitly
  out of scope. Users who want per-directory active-space state can script
  it themselves around `me use`.
- **No key identity verification** in `me ci install` v1.
- **No committed harness state.** Cloning a repo cannot alter Memory Engine's
  behavior on the cloning machine.

---

## 11. Coordination surface (frozen)

The implementation contracts are now frozen in
[`HARNESS_INTEGRATIONS_CONTRACTS.md`](HARNESS_INTEGRATIONS_CONTRACTS.md):

1. `installations.yaml` schema and artifact ownership: section 3.
2. Config schema, resolver, and writer APIs: section 4.
3. Harness registry names and APIs: section 2.
4. Module ownership and dependency direction: section 1.

Workstreams 1 (CI rewrite), 2a (registry + installations inventory), and 3a
(local config schema + resolver) may now start in parallel. The config and
registry module APIs are stable seams for the `me init` workstream.

---

## 12. Related design memory (authoritative)

The concrete decisions and their reasoning live in
`/share/projects/memory_engine/design/harness-integrations/`. This document
tracks the outcome, not the debate. When something here is ambiguous, the
decision memories are the source of truth:

- `decisions/global-dormant-dispatcher-2026-07`
- `decisions/harness-config-local-only-2026-07`
- `decisions/ci-config-lives-in-workflow-2026-07`
- `decisions/install-uninstall-init-ci-commands-2026-07`
- `decisions/local-config-schema-2026-07`
- `decisions/me-ci-install-wizard-2026-07`
- `decisions/me-init-wizard-2026-07`
- `decisions/me-init-bootstrap-space-creation-2026-07`
- `decisions/wave-1-unblockers-2026-07`
- `implementation/workstream-breakdown-2026-07`
