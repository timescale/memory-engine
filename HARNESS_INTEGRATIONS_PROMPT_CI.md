# Agent Prompt - Wave 1 CI Rewrite

You are Agent A. Work only in `/Users/john/projects/me0`.

## Mission

Implement the CI workflow redesign described in:

- `/Users/john/projects/me0/HARNESS_INTEGRATIONS_REQUIREMENTS.md`, especially
  sections 2.5, 5, 6, 7, 8, and 9.
- `/Users/john/projects/me0/HARNESS_INTEGRATIONS_CONTRACTS.md` for shared
  boundaries.

Read those files before editing. They are the design authority.

## Scope

Implement `me ci install` as the new GitHub Actions scaffold generator.

Required behavior:

- Generate `.github/workflows/me-import.yml`.
- Refuse when that file exists unless `--force`; `--force` replaces the whole
  file, with no marker or merge logic.
- Generated workflow explicitly runs:
  - `me import git --tree <tree>`
  - `me import docs . --git-aware --prune --tree <tree>`
- Bake `ME_API_KEY`, `ME_SPACE`, and, when required, `ME_SERVER` into the
  workflow environment.
- Implement the TTY wizard and non-interactive flags defined in requirements
  section 2.5.
- Preserve the existing service-account safety invariants: only mint a key for
  immediate secret placement; revoke it when placement fails; enrich relevant
  authorization denials with space-admin contacts.
- Existing-key path uses hidden input and pipes directly to `gh secret set`.
  Never print, log, persist, or add the pasted key to generated workflow text.
- Existing users who are not a space admin get the existing-key path plus the
  exact manual instructions path; do not offer general space creation.
- Retire `me import ci`.
- Make `me project ci` a deprecated hard redirect to `me ci install` for the
  specified migration window.
- Remove the legacy `.me/config.yaml` `import:` schema/configuration behavior
  relevant to old CI setup. Runtime local-config migration is another agent's
  scope.

Update user docs and docs navigation/test links for the new command. Follow
`AGENTS.md`: user documentation belongs under `docs/`, command pages need nav
entries, and CLI docs-link tests must pass.

## Likely files

- `packages/cli/commands/project-ci.ts`
- `packages/cli/commands/import-ci.ts`
- `packages/cli/commands/project.ts`
- `packages/cli/commands/import.ts`
- `packages/cli/index.ts`
- `packages/cli/project-config.ts`
- Existing CI command tests and new `packages/cli/commands/ci*.test.ts`
- `docs/cli/me-project.md`
- `docs/cli/me-import.md`
- New `docs/cli/me-ci.md`
- `docs/project-config.md`
- `packages/docs-site/lib/nav.ts`

Inspect actual wiring before deciding exact filenames. Keep the change
minimal; do not create a framework around a one-command workflow generator.

## Explicit non-scope

Do not edit:

- `packages/cli/harness/**`
- `packages/cli/local-config.ts`
- Provider installers/adapters (`claude`, `opencode`, `codex`, `gemini`)
- `me init`.

Do not change shared contract documents. Report any contradiction instead.

## Verification

- Add focused tests for workflow generation, existing-file refusal/force
  replacement, and secret/key-placement safety paths.
- Run relevant focused tests while iterating.
- Run `./bun run check` before committing.
- Do not run live harness smoke tests.

## Handoff

Commit your work. Return:

1. Commit hash.
2. Files changed.
3. Test commands/results.
4. Deferred items or contract conflicts.
