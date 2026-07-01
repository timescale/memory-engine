/**
 * Project-scoped configuration — `.me/config.yaml`.
 *
 * A project can pin its Memory Engine server + space (and optionally a project
 * tree for integrations) in a `.me/config.yaml` at the repo root — or any
 * ancestor of the current directory. When present it sits between environment
 * variables and the user's global `~/.config/me` config in the resolution
 * precedence, so any `me` invocation inside the project — CLI, `me mcp`, the
 * capture hooks, `me import git` — targets the project's server/space without
 * per-command flags.
 *
 * Discovery: walk up from a starting directory to the filesystem root; the first
 * directory containing a `.me/config.yaml` (or `.me/config.local.yaml`) wins. Or
 * point `--config-dir <dir>` / `ME_CONFIG_DIR` at the directory that contains
 * `.me/` to use it directly (no walk).
 *
 * A sibling `.me/config.local.yaml` overrides the committed `.me/config.yaml`
 * per field — mirroring Claude Code's `settings.json` vs `settings.local.json`
 * split: the committed file is shared with the team, the `.local` one is
 * personal (gitignored). This is how a "private" project keeps its home tree out
 * of version control.
 *
 * Precedence per field, highest first:
 *   --flag  >  ME_* env  >  .me/config.local.yaml  >  .me/config.yaml
 *           >  ~/.config/me global config  >  built-in default
 *
 * This module is intentionally free of any dependency on `credentials.ts` so the
 * latter can import it without a cycle.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/** The per-project config directory and its files. */
const CONFIG_DIRNAME = ".me";
const CONFIG_FILENAME = "config.yaml";
const LOCAL_CONFIG_FILENAME = "config.local.yaml";

/**
 * Lenient tree-path shape (mirrors protocol `treePathInputPattern`, but
 * non-empty): ltree labels separated by `.`/`/`, an optional leading `~`. The
 * value is normalized server-side per caller (`normalizeTreePath`); this is only
 * a cheap gate so an obviously-bad value doesn't silently flow into a tree.
 */
const TREE_PATH_RE = /^[A-Za-z0-9_~./-]+$/;

/**
 * Schema for `.me/config.yaml`. Every field is optional — a `.me` may pin only a
 * `tree`, inheriting server/space from the global config. A present-but-invalid
 * field (or unparseable YAML) is a fatal {@link ProjectConfigError}: better to
 * fail loudly than silently ignore the pins the project meant to apply.
 */
const projectConfigSchema = z.object({
  /** Pins the server URL (normalized to an origin where consumed). */
  server: z.string().min(1).optional(),
  /** Pins the space slug (the X-Me-Space). */
  space: z.string().min(1).optional(),
  /**
   * The full project-tree root for integrations (capture hooks, `me import
   * git`). Integrations nest UNDER it without appending a project slug — so
   * `/share/projects/foo` yields `…/foo/agent_sessions`, not `…/foo/<slug>/…`.
   */
  tree: z.string().min(1).regex(TREE_PATH_RE).optional(),
  /**
   * An agent to act as. Parsed for forward-compatibility but NOT yet wired to
   * any behavior — "act as an agent" (`--agent` / `ME_AGENT`) is a follow-up.
   */
  agent: z.string().min(1).optional(),
});

/** Resolved project config plus the directory whose `.me/` produced it. */
export type ProjectConfig = z.infer<typeof projectConfigSchema> & {
  /** The directory that contains the `.me/` (the project root). */
  dir: string;
};

/**
 * Thrown when a `.me/config.yaml` (or `.local.yaml`) is present but unparseable
 * or fails schema validation. Fatal for direct CLI / `me mcp` use (surfaces as a
 * clear error and non-zero exit); the best-effort capture hooks catch it and
 * skip, so a typo never breaks an agent session.
 */
export class ProjectConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectConfigError";
  }
}

/**
 * Read + validate one `.me` config file. Returns undefined when the file is
 * absent; throws {@link ProjectConfigError} when it exists but is invalid YAML
 * or fails schema validation.
 */
function readConfigFile(
  path: string,
): z.infer<typeof projectConfigSchema> | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf-8")) ?? {};
  } catch (error) {
    throw new ProjectConfigError(
      `${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = projectConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? ` (field '${issue.path.join(".")}')` : "";
  throw new ProjectConfigError(
    `${path} is invalid${where}: ${issue?.message ?? "does not match the .me/config.yaml schema"}`,
  );
}

/**
 * Walk up from `startDir` to the filesystem root, returning the first directory
 * that holds a `.me/config.yaml` or `.me/config.local.yaml`. Undefined when none
 * is found.
 */
function findConfigRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (
      existsSync(join(dir, CONFIG_DIRNAME, CONFIG_FILENAME)) ||
      existsSync(join(dir, CONFIG_DIRNAME, LOCAL_CONFIG_FILENAME))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached the filesystem root
    dir = parent;
  }
}

/**
 * Resolve the project config for `startDir`. When `configDir` is given (from
 * `--config-dir` / `ME_CONFIG_DIR`) it is the directory containing `.me/` and no
 * walk-up happens; otherwise discovery walks up from `startDir`. The `.local`
 * file overrides the committed one per field. Returns undefined when neither
 * file exists.
 */
export function discoverProjectConfig(
  startDir: string,
  configDir?: string,
): ProjectConfig | undefined {
  const dir = configDir ? resolve(configDir) : findConfigRoot(startDir);
  if (!dir) return undefined;
  const committed = readConfigFile(join(dir, CONFIG_DIRNAME, CONFIG_FILENAME));
  const local = readConfigFile(
    join(dir, CONFIG_DIRNAME, LOCAL_CONFIG_FILENAME),
  );
  if (!committed && !local) return undefined;
  return { ...committed, ...local, dir };
}

// =============================================================================
// Process-wide memoized accessor
// =============================================================================

let configDirOverride: string | undefined;
let cached: { value: ProjectConfig | undefined } | undefined;

/**
 * Seed the `--config-dir` override (called once from the root `preAction` hook,
 * before any command resolves credentials). Invalidates the memoized value.
 */
export function setConfigDirOverride(dir: string | undefined): void {
  if (dir === configDirOverride) return;
  configDirOverride = dir;
  cached = undefined;
}

/**
 * The resolved project config for the current process (discovered from
 * `process.cwd()`, honoring `--config-dir` / `ME_CONFIG_DIR`), memoized so the
 * walk-up runs once even though `resolveServer`/`resolveSpace` call it per
 * command. Returns undefined when there is no `.me` in scope.
 */
export function getProjectConfig(): ProjectConfig | undefined {
  if (cached) return cached.value;
  const configDir = configDirOverride ?? process.env.ME_CONFIG_DIR ?? undefined;
  const value = discoverProjectConfig(process.cwd(), configDir);
  cached = { value };
  return value;
}

/** Reset the memoized config + config-dir override. Test-only. */
export function resetProjectConfigCache(): void {
  configDirOverride = undefined;
  cached = undefined;
}
