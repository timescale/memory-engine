# Project Registry Refactor Plan

## Goals

- Rename the API to match what it does:
  - `SlugRegistry` -> `ProjectRegistry`
  - `ProjectContext` stays `ProjectContext`
  - `normalizeSlug` -> `normalizeProjectSlug`
  - `repoNameFromRemote` stays `repoNameFromRemote`
  - keep the returned field named `slug`, because it is the actual tree label value
- Split responsibilities:
  - `ProjectRegistry` resolves/stabilizes project identity and handles collision suffixing.
  - `detectGitContext(dir)` detects git root/remote without implying slug or destination derivation.
- Avoid unnecessary project slug resolution:
  - If `--tree` is explicit, importers should not resolve a project slug just to place data.
  - They may still call `detectGitContext()` if they need git behavior.

## Rationale

The current docs importer enables git-aware behavior implicitly whenever the import root happens to be inside a git work tree. That makes the command clever, but surprising: a manual `me import docs` can import a different corpus depending on whether the directory is nested under a repo, whether generated docs are gitignored, and whether the user happened to run it from the repo root or a subdirectory. The PostgreSQL docs case is the sharp edge: the markdown files exist on disk, but because the generated `markdown/` directory is gitignored, git-mode discovery sees `0` files. From a terminal user's point of view, that reads as the tool refusing to import the docs they explicitly pointed at.

The command has two distinct use cases that should not share one implicit mode switch:

- Manual imports: the least surprising behavior is "import the files under this directory." Plain filesystem walking should be the default, including generated or gitignored docs, with no repo-root assumptions.
- CI/repo-managed imports: the useful behavior is git-aware discovery, gitignore filtering, git last-modified dates, and repo-root safety. That should be explicit via `--git-aware`, because CI workflows can and should encode that intent.

This also separates destination from source interpretation. `--tree /a/b/c` should answer only "where should these memories land?" It should not force project slug resolution, and it should not imply either git-aware or non-git discovery. `--git-aware` should answer the separate question "should the source directory be interpreted as a git-managed docs corpus?"

Generated docs inside a repo need a third explicit shape: repo-context import while still including gitignored build output. `--git-aware --include-ignored` covers that case without making plain terminal imports clever again.

## 1. Rename And Reshape `packages/cli/importers/slug.ts`

Prefer renaming the file to `packages/cli/importers/project.ts` rather than keeping the old `slug.ts` name.

Export:

```ts
export interface GitContext {
  gitRoot?: string;
  gitRemote?: string;
}

export interface ProjectContext extends GitContext {
  slug: string;
  baseSlug: string;
  cwd: string;
}

export async function detectGitContext(cwd: string): Promise<GitContext>;

export function normalizeProjectSlug(raw: string): string;

export function repoNameFromRemote(url: string): string | undefined;

export function boundedUniqueLabel(
  id: string,
  normalize: (s: string) => string,
  maxLen: number,
): string;

export class ProjectRegistry {
  async resolve(cwd?: string): Promise<ProjectContext>;
  collisions(): Array<{ baseSlug: string; cwds: string[] }>;
}
```

Implementation details:

- Move current `detectGitRoot`, `detectGitRemote`, and `getGitInfo` behind exported `detectGitContext`.
- Keep caching behavior from `getGitInfo`, but rename it internally to something like `gitContextCache`.
- `ProjectRegistry.resolve()` should call `detectGitContext()` and then derive the slug.
- Preserve current collision behavior exactly.

## 2. Update Imports And Tests

Replace internal references:

- `SlugRegistry` -> `ProjectRegistry`
- `normalizeSlug` -> `normalizeProjectSlug`
- `ProjectContext` import path updated
- `./slug.ts` -> `./project.ts`

Known call sites:

- `packages/cli/agent/memory-pointer.ts`
- `packages/cli/commands/import-docs.ts`
- `packages/cli/commands/import-git.ts`
- `packages/cli/commands/opencode.ts`
- `packages/cli/commands/project.ts`
- `packages/cli/importers/index.ts`
- `packages/cli/importers/markdown-files.ts`
- tests currently in `packages/cli/importers/slug.test.ts`

Test rename:

- `slug.test.ts` -> `project.test.ts`
- `describe("SlugRegistry")` -> `describe("ProjectRegistry")`
- `describe("normalizeSlug")` -> `describe("normalizeProjectSlug")`
- Add `detectGitContext` coverage:
  - returns `{ gitRoot, gitRemote }` inside a repo
  - returns `{}` outside a repo
  - returns `gitRoot` but undefined `gitRemote` for a repo with no origin

## 3. Decouple `me import docs`

Change the command model so plain filesystem import is the default, and git-aware behavior is explicit:

- `me import docs` -> plain mode
- `me import docs --git-aware` -> repo-managed docs mode
- `me import docs --git-aware --include-ignored` -> repo-context import for generated/gitignored docs

Plain mode should be the least surprising terminal behavior:

- no git detection
- filesystem walk via `discoverPlainFiles`
- gitignored/generated files are included naturally
- no git last-modified dates
- no subdir-root guard
- if no `--tree` and no `.me` tree, slug derives from `basename(dir)` via `normalizeProjectSlug`
- `--prune` remains root-sensitive; document this clearly rather than adding implicit git safety

Git-aware mode should be explicit and strict:

- `--git-aware` requires `dir` to be inside a git repo; if no git root, error
- discovery uses git context
- by default, git-aware discovery respects gitignore
- git last-modified dates are used unless `--no-temporal`
- the subdir-root guard applies unless `--allow-subdir-root`
- if no `--tree` and no `.me` tree, slug derives from git remote/root via `ProjectRegistry`

Generated-docs mode preserves repo context while including build output:

- `--include-ignored` is valid only with `--git-aware`
- if passed without `--git-aware`, error with: `--include-ignored requires --git-aware; plain mode already walks files on disk`
- discovery includes tracked files, untracked-not-ignored files, and ignored untracked files
- ignored/untracked files have no git dates
- tracked files can still get git last-modified dates
- subdir-root guard still applies, because this is still git-aware mode

Destination derivation should become explicit:

```ts
const explicitProjectNode = opts.tree ?? creds.tree;

let slug: string | undefined;
if (!explicitProjectNode) {
  slug = opts.gitAware
    ? (await new ProjectRegistry().resolve(dir)).slug
    : normalizeProjectSlug(basename(dir));
}

const projectNode =
  explicitProjectNode ??
  `${creds.treeRoot ?? DEFAULT_PRIVATE_TREE_ROOT}.${slug}`;
```

Git behavior should be separate:

```ts
const gitContext = opts.gitAware ? await detectGitContext(dir) : {};
if (opts.gitAware && !gitContext.gitRoot) {
  throw new Error("--git-aware requires dir to be inside a git repository");
}
const gitMode = gitContext.gitRoot !== undefined;
```

Discovery should be:

```ts
if (gitMode) {
  const listing = await listGitFiles(dir, {
    includeIgnored: opts.includeIgnored,
  });
  candidates = listing.files;
  untracked = listing.untracked;
} else {
  candidates = await discoverPlainFiles(dir);
}
```

`listGitFiles(dir, { includeIgnored })` should keep current behavior by default. When `includeIgnored` is true, do a second explicit git pass and merge/dedup:

```bash
git ls-files -z -t --cached --others --exclude-standard
git ls-files -z -t --others --ignored --exclude-standard
```

All ignored-path results from the second pass should be considered untracked for temporal purposes and excluded from `lastModifiedByPath` targets.

The existing 0-only gitignored diagnostic should only run in git-aware mode when `--include-ignored` is not set:

```ts
if (gitMode && !opts.includeIgnored && relPaths.length === 0) {
  const onDisk = filterDocPaths(await discoverPlainFiles(dir), ...);
  if (onDisk.length > 0) warn/pass structured field;
}
```

Result:

- `--tree /share/pg/18` no longer resolves a slug at all.
- `--tree` alone uses plain filesystem discovery.
- `--tree --git-aware` uses git discovery/dates but still does not use slug for placement.
- `--tree --git-aware --include-ignored` uses repo-context discovery while including generated/gitignored docs.

## 4. Decouple `me import git`

`me import git` still needs git root/remote because it imports git history, but with explicit `--tree` it does not need project slug for placement.

Proposed flow:

```ts
const gitContext = await detectGitContext(repoPath);
if (!gitContext.gitRoot) ...not repo...

let slug: string | undefined;
if (!opts.tree && !creds.tree) {
  slug = (await new ProjectRegistry().resolve(repoPath)).slug;
}

const projectNode =
  opts.tree ??
  creds.tree ??
  `${creds.treeRoot ?? DEFAULT_PRIVATE_TREE_ROOT}.${slug}`;
```

Important metadata decision:

- `source_project_slug` metadata may still expect a slug.
- Recommendation: keep deriving slug for `import git` metadata, even when explicit `--tree` controls placement, because the source is inherently a git project and repo identity remains useful for search/filtering.
- The key invariant is that `--tree` suppresses slug-derived placement, not necessarily source metadata.

## 5. Session Importers (`claude` / `codex` / `opencode`)

These use project identity as the core grouping key, so the registry remains appropriate.

Cleanup:

- Rename local variable `slugs` -> `projects` in `packages/cli/importers/index.ts`.
- Keep current behavior unless a true full-tree override is introduced later.

Current default should remain:

```text
<tree-root>/<project-slug>/agent_sessions/<session-id>/...
```

Session importers use `--tree-root`, not an exact `--tree`, so they still need per-project slug grouping.

## 6. Project Root Only Call Sites

Some call sites use `new SlugRegistry().resolve()` only to get `gitRoot`. These should switch to `detectGitContext()`:

- `packages/cli/agent/memory-pointer.ts`
  - `rulesFilePath()` only needs `gitRoot`
  - `resolveMemoryPointer()` needs both slug and gitRoot, so keep `ProjectRegistry.resolve()` unless `creds.tree` exists and slug is only for fallback
- `packages/cli/commands/project.ts`
  - `runProjectInitWizard()` needs slug for default tree prompt and gitRoot for config location, so `ProjectRegistry.resolve()` remains fine
  - non-interactive project root lookup only needs gitRoot -> use `detectGitContext()`
- `packages/cli/commands/opencode.ts`
  - `resolveProjectRoot()` only needs gitRoot -> use `detectGitContext()`

## 7. Re-export Surface

`packages/cli/importers/index.ts` currently re-exports `SlugRegistry`.

Update to:

```ts
export { ProjectRegistry } from "./project.ts";
```

Potentially also export:

```ts
export { detectGitContext, normalizeProjectSlug } from "./project.ts";
```

Only export what consumers need.

No backward compatibility shim is needed unless external packages import `@memory.build/cli/importers/slug.ts`. Check package exports before implementation. If it is not exported in `package.json`, do a clean break.

## 8. Update Comments And Docs

Code comments currently say "slug" in several places where they now mean "project identity".

Update:

- file header from "Project slug derivation" to "Project identity resolution"
- `git-files.ts` comment that says "SlugRegistry's gitRoot" -> "detectGitContext / import command git context"
- import docs comments around plain/default mode, `--git-aware`, `--include-ignored`, and destination derivation
- session importer comments where "slugs" refers to registry state

User-facing docs do not need changes for the internal rename, but `docs/cli/me-import.md` must document the docs-import behavior change:

- `me import docs` is plain by default and imports files on disk, including gitignored/generated files.
- `--git-aware` opts into repo-managed behavior: git discovery, git dates, and subdir-root safety.
- `--git-aware` outside a repo errors.
- `--include-ignored` is only valid with `--git-aware` and includes generated/gitignored docs while preserving repo context.
- Plain-mode `--prune` is root-sensitive; keep this explicit. Users who want repo-root safety should use `--git-aware`.

Example docs should include:

```bash
me import docs ./markdown --tree /share/pg/18
me import docs . --git-aware --tree /share/acme
me import docs ./build/docs --git-aware --include-ignored --allow-subdir-root --tree /share/acme
```

## 9. Tests

Add docs-import tests for the new mode model:

- default options: `gitAware: false`, `includeIgnored: false`
- `--git-aware` maps through
- `--include-ignored` maps through and is rejected without `--git-aware`
- default docs import path uses plain discovery
- `--git-aware` outside a repo errors
- `--git-aware` uses git discovery and respects gitignore by default
- `--git-aware --include-ignored` includes ignored/generated files
- gitignored 0-only diagnostic appears only for `--git-aware` without `--include-ignored`
- explicit `--tree` avoids project slug resolution for placement
- plain-mode `--prune` remains root-sensitive; no implicit git-root guard

Run targeted tests first:

```bash
./bun test packages/cli/importers/project.test.ts
./bun test packages/cli/commands/import-docs.test.ts packages/cli/importers/docs.test.ts packages/cli/importers/git-files.test.ts
./bun test packages/cli/importers/index.test.ts packages/cli/importers/import-transcript.test.ts
```

If a git importer test file exists, also run it:

```bash
./bun test packages/cli/commands/import-git.test.ts
```

Then run:

```bash
./bun run typecheck
./bun x biome check <changed files>
./bun run check
```

Known caveat:

- Full `check` currently has pre-existing harness env-injection failures on this branch. Re-run to confirm whether still unrelated and report them separately if unchanged.

## 10. Implementation Order

1. Create `importers/project.ts` from `slug.ts` with renamed exports and `detectGitContext`.
2. Update tests from `slug.test.ts` to `project.test.ts`; add `detectGitContext` coverage.
3. Update all imports mechanically.
4. Replace gitRoot-only `ProjectRegistry.resolve()` calls with `detectGitContext()`.
5. Refactor `import-docs.ts` to make plain mode the default and add explicit `--git-aware`.
6. Add `--include-ignored`, valid only with `--git-aware`, and update `listGitFiles` to include ignored files when requested.
7. Refactor `import-docs.ts` destination derivation so explicit `--tree` avoids project resolution.
8. Refactor `import-git.ts` so explicit `--tree` avoids using slug for placement, while preserving slug metadata if needed.
9. Update comments, docs, and re-exports.
10. Run verification.

## Open Decision

For `me import git`, explicit `--tree` should suppress slug-based placement, but should it also suppress slug-based metadata (`source_project_slug`)?

Recommendation: suppress it only for placement. Keep metadata stable because the source is still a git project, and search/filtering by repo identity remains useful.
