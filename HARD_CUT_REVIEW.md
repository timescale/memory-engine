# Review: hard cut from `.me/config.yaml`

The branch is mid-cut. The new machine-local model (`local-config.ts` profiles +
`me init`/`me doctor`) is wired for `me mcp`, the Claude/OpenCode capture hooks,
and harness CLI routing. But the **entire `.me` discovery/read/write/validation/
routing stack is still present and still live** on the import paths, plus a large
amount of now-orphaned command/test/doc surface. One test is already failing.

Findings are ordered by severity.

---

## CRITICAL

### C1 — `packages/cli/project-config.ts` (whole file, 1–375) still implements the retired model
`discoverProjectConfig`, `findConfigRoot` (walk-up), `readConfigFile`,
`writeProjectConfig`, `writeProjectSpace`, `getProjectConfig` (reads
`ME_CONFIG_DIR`/`ME_PROJECT_DIR`), `validatedHarnessProjectDir` (the
`CLAUDE_PROJECT_DIR` → `.me/` backstop), and the `projectConfigSchema`
(including retired `agent`/`import`/`capture` keys) all read/write
`.me/config.yaml` + `.me/config.local.yaml`.

- **Why it violates:** this is the discovery/validation engine the hard cut
  removes; `ME_PROJECT_DIR` must be a profile anchor only, never trigger `.me`
  discovery (getProjectConfig:357–365 does exactly that).
- **Minimal fix:** delete the file. **Caveat:** `VALID_TREE_PATH_RE` (49) is
  re-exported and consumed by `credentials.ts:48` and `import.ts:56` for tree
  validation — relocate that one constant (e.g. into `import.ts`/a small util)
  rather than dropping it.

### C2 — `packages/cli/credentials.ts` still carries the `.me` routing surface
- `resolveCredentialsFor(project)` (723–727), `credentialsFor(project)`
  (730–752) with `project?.tree` (749) and
  `captureEnabled: project?.capture ?? config.capture === true` (751),
  `resolveServerFor(project)` (670–686).
- `.me` server-pin trust machinery: `DEFAULT_TRUSTED_SERVERS` (68),
  `isDefaultTrustedServer` (76), `getServerWhitelist` (607),
  `assertProjectServerAllowed` (621), `projectServerOrigin` (635), and
  `server_whitelist` handling in `ConfigFile`/`readConfig` (100, 257–266).
- Retired global fields still read: `capture` (107, 270–273, 302), `tree_root`
  (117, 276–284, 303), `agent` (122, 287–304), and the `ProjectConfig` import (46).

- **Why it violates:** these exist solely to resolve/validate/route through `.me`
  (and the retired top-level global `capture`). Under the cut, resolution is
  flags + `ME_*` + global active_space + `local-config` profiles only.
- **Minimal fix:** delete `resolveCredentialsFor`/`credentialsFor(project)`
  param/`resolveServerFor(project)` param and collapse to the project-less path;
  remove the whitelist/trusted-server gate; drop
  `tree`/`treeRoot`/`captureEnabled`/`server_whitelist`/`capture`/`agent` from
  `ConfigFile`/`ResolvedCredentials`/`readConfig`.

### C3 — Session import router still discovers `.me` per session
`packages/cli/commands/import.ts:255` `resolveCredentialsFor(discoverProjectConfig(cwd))`
inside `createSessionRouter` (227–293), plus the `--config-dir`/`ME_CONFIG_DIR`
guard at 314–324 (a flag no longer registered — see M2).

- **Why it violates:** a bulk sweep still routes each session by its project's
  `.me` server/space/tree. This is a live production `.me` path.
- **Minimal fix:** route sessions through `local-config` capture/directory
  profiles (or explicit `--server/--space/--tree-root/ME_*`); delete
  `createSessionRouter`'s `discoverProjectConfig`/`resolveCredentialsFor` usage
  and the removed-flag guard.

### C4 — `me import git` still discovers `.me`
`packages/cli/commands/import-git.ts:185`
`resolveCredentialsFor(discoverProjectConfig(repoPath))`, gated by the
removed-flag read at 178–180 (`globalOpts.configDir`/`ME_CONFIG_DIR`), tree from
`creds.tree` at 204.

- **Minimal fix:** resolve credentials via `resolveCredentials(serverFlag)` +
  explicit `--tree`/profile; delete the `.me` branch and the `configDir` read.

### C5 — `me import docs` still discovers `.me`
`packages/cli/commands/import-docs.ts:293`
`resolveCredentialsFor(discoverProjectConfig(dir))` (import at 55).

- **Minimal fix:** same as C4.

### C6 — Capture-enable flow writes a now-ignored `.me` flag
`packages/cli/agent/capture-step.ts` (whole file): `captureEnableStep.run` →
`writeProjectConfig(..., { capture: true })` (48) and `applyCaptureDeselection`
→ `writeProjectConfig(..., { capture: false })` (71); availability reads
`discoverProjectConfig(...).capture` (42).

- **Why it violates:** directly violates goal #5 — writes `.me/config.yaml
  capture:` which the runtime hooks (claude.ts:105, opencode.ts:115) no longer
  read (they use `resolveCaptureProfile`). Dead write of a retired flag.
- **Minimal fix:** delete the file and its only consumer (project.ts, C7).

### C7 — Orphaned `me project` command
`packages/cli/commands/project.ts` (whole file, 577 lines):
`createProjectCommand`/`createProjectInitCommand`/`runProjectInitWizard` are
**not registered** in `index.ts`, and write `.me` via `writeProjectConfig` (318)
and the memory-pointer `managedBy: "me project init"` blocks (331/339). Also
exports the `createRemovedCommand`/`createProjectCiRedirectCommand` stubs.

- **Minimal fix:** delete the file.

### C8 — CLI docs-parity test already failing
`packages/cli/docs-cli-links.test.ts:64–66` map `createProjectCommand:
"me-project"` and `createRemovedCommand: null`, but neither is registered in
`index.ts` anymore → test "COMMAND_DOCS has no stale entries" fails now
(verified: `Received ["createProjectCommand","createRemovedCommand"]`).

- **Minimal fix:** remove both entries; delete `docs/cli/me-project.md` (test #3
  orphan check) and its nav entry (H4).

---

## HIGH

### H1 — Dead capture-prompt writing the retired global `capture` flag
`packages/cli/commands/capture-prompt.ts` — `runCapturePrompt` (18) has no
callers; calls `setCaptureEnabled`/`getGlobalCaptureEnabled`
(credentials.ts:553/560) which persist/read the retired top-level global
`capture`. Runtime capture is now `resolveCaptureProfile` (local-config).

- **Minimal fix:** delete `capture-prompt.ts` and remove
  `setCaptureEnabled`/`getGlobalCaptureEnabled` from credentials.ts.

### H2 — Dead init-checklist builder
`packages/cli/agent/init.ts:213 buildInitCommand` has no non-test callers (it
built the retired `me claude init`/`me opencode init`).
`runInitSteps`/`INIT_STEPS`/`initOutroLead` are only consumed by the orphaned
project.ts (C7).

- **Minimal fix:** delete `buildInitCommand` and the init-step infra once
  project.ts is removed; keep only anything still referenced by
  `claude.ts`/`opencode.ts` (currently just the `StepAvailability` type).

### H3 — `me space use` docs still describe `.me` writeback
`docs/cli/me-space.md:67–70` say `me space use` updates
`.me/config.local.yaml`/`.me/config.yaml` when a project pins `space`. The code
(space.ts:263) is now global-only (`setActiveSpace`) — verified. Doc contradicts
goals #4/#6.

- **Minimal fix:** replace 67–70 with "always writes the global active space."

### H4 — Stale docs pages + nav entries for the retired model
`docs/cli/me-project.md` and `docs/project-config.md` document `me
project`/`.me/config.yaml`; `packages/docs-site/lib/nav.ts:23` ("Project config
(.me)" → `project-config`) and `:46` ("me project" → `cli/me-project`) reference
them. `nav.test.ts` enforces nav↔page parity, so page deletion must update nav
together.

- **Minimal fix:** delete both pages, remove both nav entries.

---

## MEDIUM

### M1 — Stale `me opencode init` claim + `.me` docstring
`packages/cli/commands/opencode.ts:11–12` states `me opencode init` "is now a
deprecated alias (wired in index.ts)" — it is **not** wired anywhere. `:88`
`--project-dir` help still says "anchor for .me/config.yaml discovery."

- **Minimal fix:** drop the init-alias sentence; reword `--project-dir` help to
  "profile-discovery anchor" (no `.me`).

### M2 — Dead reads of the removed `--config-dir` flag
`index.ts` no longer registers `--config-dir`/`--project-dir` nor seeds
`setConfigDirOverride`/`setProjectDirOverride`, yet `import.ts:314` and
`import-git.ts:179` still branch on `globalOpts.configDir` (always undefined) +
`ME_CONFIG_DIR`. Removed as part of C3/C4.

### M3 — `project-ci.ts` depends on the `.me` routing helper
`packages/cli/commands/project-ci.ts:452` `resolveCredentialsFor(undefined)` and
the `.me` comment at 450–451. Functionally safe (passes `undefined`), but only
compiles because `resolveCredentialsFor` still exists (C2).

- **Minimal fix:** switch to `resolveCredentials()` when C2 lands; drop the `.me`
  comment.

### M4 — `local-config.ts` legacy-capture migration
`packages/cli/local-config.ts:309 migrateLegacyCapture` migrates the retired
global `capture`/`tree_root` into a defaults profile; the TODO at 326–328
explicitly notes the credentials resolver still reads them.

- **Why it violates:** the hard cut forbids migration import/fallback. Once C2
  removes the legacy reads, this migration should go too.
- **Minimal fix:** delete `migrateLegacyCapture` and its two call sites (341, 457).

### M5 — README/contributor docs still teach the retired model
`README.md:35–40,60` (`me project init` writing `.me/config.yaml`),
`CLAUDE.md`/`AGENTS.md:13,60,280` (Project Config page, `project` command,
`project-config.ts` resolution, `.me`, `ME_CONFIG_DIR`/`--config-dir`).

- **Minimal fix:** rewrite these to the machine-local model (`me init`/`me
  doctor`, `local-config.ts`, `ME_PROJECT_DIR` as profile anchor only).

### M6 — Remaining user docs referencing `.me`/`project-config`/`ME_CONFIG_DIR`
`docs/projects.md`, `docs/getting-started.md`, `docs/joining-a-space.md`,
`docs/index.md`, `docs/mcp-integration.md`, `docs/cli/me-import.md`,
`docs/cli/me-mcp.md`, `docs/cli/me-opencode.md`,
`docs/cli/agent-session-imports.md`.

- **Minimal fix:** purge `.me`/`--config-dir`/`ME_CONFIG_DIR`/`me project`
  references; point at profiles/flags/`ME_*`.

---

## LOW

### L1 — Dead/obsolete tests to delete outright
`packages/cli/project-config.test.ts`, `packages/cli/agent/capture-step.test.ts`,
`packages/cli/commands/project.test.ts` — all cover deleted code.

### L2 — Tests to prune (retain non-`.me` coverage)
`packages/cli/credentials.test.ts` (ProjectConfig/whitelist/`--config-dir`
cases), `packages/cli/commands/import.test.ts` (`discoverProjectConfig`/router
`.me` cases), `e2e/cli.e2e.test.ts` (`ME_CONFIG_DIR`/`--config-dir`/`.me`).

### L3 — Stale comments in `space.ts`
`packages/cli/commands/space.ts:533` ("leave a ME_SPACE / `.me` pin alone")
references `.me`; reword to global-only. (The `ME_SPACE` warning at 272 is still
correct.)

---

## Summary of the minimal removal set

- **Delete:** `project-config.ts`, `agent/capture-step.ts`, `commands/project.ts`,
  `commands/capture-prompt.ts`, `agent/init.ts` init-command infra,
  `docs/cli/me-project.md`, `docs/project-config.md`, and the three dead tests (L1).
- **Gut** the `.me`/project routing out of `credentials.ts` (C2) and re-home
  `VALID_TREE_PATH_RE`.
- **Rewire** the three import paths (C3/C4/C5) to flags + `local-config` profiles.
- **Fix** parity/nav/docs (C8/H3/H4/M-series) and prune the remaining tests (L2).

No compatibility shims: every item is a removal or a redirect to the flags /
`ME_*` / global-config / `local-config.ts` surfaces.
