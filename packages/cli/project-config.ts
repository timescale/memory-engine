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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, parseDocument } from "yaml";
import { z } from "zod";

/** The per-project config directory and its files. */
const CONFIG_DIRNAME = ".me";
const CONFIG_FILENAME = "config.yaml";
const LOCAL_CONFIG_FILENAME = "config.local.yaml";

/**
 * Tree-path shape shared by every client-side tree gate (the `.me` `tree`,
 * the global `tree_root`, the `--tree`/`--tree-root` flags): ltree labels
 * (`[A-Za-z0-9_-]`) separated by `.` or `/`, with an optional leading `/` or
 * `~` (bare `~` = your home root). Strict about the shape — `~` only at the
 * start, no empty labels (`a..b`), no trailing separators — so a typo fails
 * loudly here instead of surfacing as a confusing server error. The value is
 * still normalized authoritatively server-side (`normalizeTreePath`).
 */
export const VALID_TREE_PATH_RE =
  /^~$|^(?:~[./]|\/)?[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$/;
const TREE_PATH_RE = VALID_TREE_PATH_RE;

/**
 * The `.user` sentinel for `agent:` — "run as the user, deliberately" (the
 * human escape hatch from the config side; see credentials.ts for the
 * `--as-agent .user` / `ME_AS_AGENT=.user` flag/env form). Valid in
 * `.me/config.local.yaml` and the global `~/.config/me/config.yaml`; a
 * committed `agent: .user` is a fatal {@link ProjectConfigError} (see
 * {@link readConfigFile}) — a repo author writing it into the tracked
 * `.me/config.yaml` would silently flip every cloning teammate's harness
 * surfaces to their own full user credentials, which is the one committed
 * value that *raises* effective privilege (a committed `agent: <name>` can at
 * worst 403, since names resolve against the caller's own agents).
 */
export const PROJECT_USER_SENTINEL = ".user";

/**
 * Schema for `.me/config.yaml`. Every field is optional — a `.me` may pin only a
 * `tree`, inheriting server/space from the global config. A present-but-invalid
 * field, an unparseable YAML, OR an unknown/misspelled key is a fatal
 * {@link ProjectConfigError}: better to fail loudly than silently ignore the
 * pins the project meant to apply. `.strict()` makes the common typo (`serer:`,
 * `spaces:`, `treeRoot:`) an error rather than a silently-stripped no-op.
 */
const projectConfigSchema = z
  .object({
    /** Pins the server URL (normalized to an origin where consumed). */
    server: z.string().min(1).optional(),
    /** Pins the space slug (the X-Me-Space). */
    space: z.string().min(1).optional(),
    /**
     * The full project TREE for integrations (capture hooks, `me import
     * git`). Integrations nest UNDER it without appending a project slug — so
     * `/share/projects/foo` yields `…/foo/agent_sessions`, not `…/foo/<slug>/…`.
     */
    tree: z.string().min(1).regex(TREE_PATH_RE).optional(),
    /**
     * The project's default agent to act as. Wired as the *value source* for the
     * `.me` sentinel: `--as-agent .me` / `ME_AS_AGENT=.me` resolves to this id
     * and is sent as `X-Me-As-Agent`. It never activates agent mode on its own —
     * a bare `.me` `agent` present in the tree does not put `me` in agent mode
     * (activation is always explicit via the flag/env).
     */
    agent: z.string().min(1).optional(),
    /**
     * Whether the installed capture hooks collect this project's agent
     * sessions. `true` turns capture on for the project regardless of the
     * user's machine-wide setting (so a committed config makes a team repo
     * capture for every member); `false` opts the project out (e.g. a
     * sensitive repo). Absent → the machine-wide setting decides (off unless
     * opted in at `me claude install`).
     */
    capture: z.boolean().optional(),
  })
  .strict();

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
 * absent; throws {@link ProjectConfigError} when it exists but is invalid
 * YAML, fails schema validation, or — for the **committed** file only — pins
 * the fatal `agent: .user` sentinel (see {@link PROJECT_USER_SENTINEL}).
 */
function readConfigFile(
  path: string,
  opts: { allowUserSentinel: boolean },
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
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length
      ? ` (field '${issue.path.join(".")}')`
      : "";
    throw new ProjectConfigError(
      `${path} is invalid${where}: ${issue?.message ?? "does not match the .me/config.yaml schema"}`,
    );
  }
  if (!opts.allowUserSentinel && parsed.data.agent === PROJECT_USER_SENTINEL) {
    throw new ProjectConfigError(
      `${path}: "agent: ${PROJECT_USER_SENTINEL}" is not allowed in the committed .me/config.yaml — it would silently switch every ` +
        `cloning teammate's harness surfaces to their own full user credentials. Use .me/config.local.yaml, the global ` +
        `~/.config/me/config.yaml, or an explicit --as-agent ${PROJECT_USER_SENTINEL} / ME_AS_AGENT=${PROJECT_USER_SENTINEL} instead.`,
    );
  }
  return parsed.data;
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
  const committed = readConfigFile(join(dir, CONFIG_DIRNAME, CONFIG_FILENAME), {
    allowUserSentinel: false,
  });
  const local = readConfigFile(
    join(dir, CONFIG_DIRNAME, LOCAL_CONFIG_FILENAME),
    {
      allowUserSentinel: true,
    },
  );
  if (!committed && !local) return undefined;
  return { ...committed, ...local, dir };
}

/**
 * Update the project's pinned space **in the `.me` file that currently defines
 * `space`** — the effective scope, like `git config` editing the config level a
 * value comes from. Checks `.me/config.local.yaml` first (it overrides the
 * committed file per field, so writing the committed one would be shadowed),
 * then the committed `.me/config.yaml`. When **neither** file defines `space`,
 * returns undefined without touching anything — the global per-server
 * `active_space` governs there, and the caller should update it instead.
 *
 * Pass `server` to rewrite the pin's server alongside the space (used when the
 * effective server differs from what the project would resolve on its own, so
 * the pin stays self-consistent).
 *
 * The edit goes through yaml's document API, so comments and formatting in a
 * committed config survive. Invalidates the process-wide memo so subsequent
 * resolution in the same process sees the write. Returns the path written.
 */
export function writeProjectSpace(
  project: ProjectConfig,
  opts: { space: string; server?: string },
): string | undefined {
  const localPath = join(project.dir, CONFIG_DIRNAME, LOCAL_CONFIG_FILENAME);
  const committedPath = join(project.dir, CONFIG_DIRNAME, CONFIG_FILENAME);
  // readConfigFile re-validates; a malformed file throws ProjectConfigError
  // here just as it does on read.
  const target =
    readConfigFile(localPath, { allowUserSentinel: true })?.space !== undefined
      ? localPath
      : readConfigFile(committedPath, { allowUserSentinel: false })?.space !==
          undefined
        ? committedPath
        : undefined;
  if (!target) return undefined;

  const doc = parseDocument(readFileSync(target, "utf-8"));
  doc.set("space", opts.space);
  if (opts.server !== undefined) doc.set("server", opts.server);
  writeFileSync(target, doc.toString());
  cached = undefined; // re-resolve on next getProjectConfig()
  return target;
}

/** The writable fields of a `.me/config.yaml` (everything but `dir`). */
export type ProjectConfigValues = z.infer<typeof projectConfigSchema>;

/**
 * Create-or-update the **committed** `.me/config.yaml` under `projectRoot`,
 * setting each provided key (undefined keys are left untouched). Unlike
 * {@link writeProjectSpace} — which edits whichever existing file defines
 * `space` — this is the general writer used by `me project init`: it creates
 * the `.me/` directory and file when absent, and always targets the committed
 * file (a project config is meant to be shared; personal overrides belong in
 * `.me/config.local.yaml`, written by hand).
 *
 * Edits go through yaml's document API so comments/formatting in an existing
 * file survive. The merged result is validated against the schema before
 * writing — so a bad value (or a malformed existing file) throws
 * {@link ProjectConfigError} and nothing is written. Invalidates the
 * process-wide memo. Returns the path written.
 */
export function writeProjectConfig(
  projectRoot: string,
  values: ProjectConfigValues,
): string {
  const dir = join(projectRoot, CONFIG_DIRNAME);
  const path = join(dir, CONFIG_FILENAME);
  // A malformed existing file throws here (same error as on read) rather
  // than being silently replaced. This targets the committed file, so the
  // fatal `.user` gate applies.
  readConfigFile(path, { allowUserSentinel: false });

  // An empty seed yields block style ("key: value" lines) once keys are set.
  const doc = existsSync(path)
    ? parseDocument(readFileSync(path, "utf-8"))
    : parseDocument("");
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) doc.set(key, value);
  }

  const merged = projectConfigSchema.safeParse(doc.toJS());
  if (!merged.success) {
    const issue = merged.error.issues[0];
    const where = issue?.path.length
      ? ` (field '${issue.path.join(".")}')`
      : "";
    throw new ProjectConfigError(
      `refusing to write ${path}${where}: ${issue?.message ?? "does not match the .me/config.yaml schema"}`,
    );
  }
  if (merged.data.agent === PROJECT_USER_SENTINEL) {
    throw new ProjectConfigError(
      `refusing to write ${path}: "agent: ${PROJECT_USER_SENTINEL}" is not allowed in the committed .me/config.yaml — it would ` +
        `silently switch every cloning teammate's harness surfaces to their own full user credentials. Use ` +
        `.me/config.local.yaml, the global ~/.config/me/config.yaml, or an explicit --as-agent ${PROJECT_USER_SENTINEL} instead.`,
    );
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, doc.toString());
  cached = undefined; // re-resolve on next getProjectConfig()
  return path;
}

// =============================================================================
// Process-wide memoized accessor
// =============================================================================

let configDirOverride: string | undefined;
let projectDirOverride: string | undefined;
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
 * Seed the `--project-dir` override (called once from the root `preAction`
 * hook) — the harness-injected discovery **anchor**, distinct from
 * `--config-dir`'s exact location: `me` still walks up from it. Invalidates
 * the memoized value.
 */
export function setProjectDirOverride(dir: string | undefined): void {
  if (dir === projectDirOverride) return;
  projectDirOverride = dir;
  cached = undefined;
}

/**
 * The validated last-resort backstop: `CLAUDE_PROJECT_DIR` (documented as set
 * in the stdio MCP server's env), consulted only when the anchor/cwd walk-up
 * finds nothing. Accepted only if the directory actually contains `.me/` — so
 * an unrelated value (Claude's desktop-Linux `$HOME` spawn bug) is silently
 * ignored rather than adopting the wrong project. It sits BELOW cwd walk-up
 * deliberately: under `claude -w` it names the MAIN checkout, not the
 * worktree, and this existence check can't tell the difference (the main
 * checkout legitimately contains `.me/` too).
 */
function validatedHarnessProjectDir(): string | undefined {
  const dir = process.env.CLAUDE_PROJECT_DIR;
  if (!dir) return undefined;
  const resolved = resolve(dir);
  return existsSync(join(resolved, CONFIG_DIRNAME)) ? resolved : undefined;
}

/**
 * The resolved project config for the current process, memoized so the
 * walk-up runs once even though `resolveServer`/`resolveSpace` call it per
 * command. Returns undefined when there is no `.me` in scope.
 *
 * Resolution order:
 *   1. `--config-dir` / `ME_CONFIG_DIR` — an EXACT location, no walk-up.
 *   2. `--project-dir` / `ME_PROJECT_DIR` — the injected session ANCHOR: walk
 *      up from it instead of cwd (replaces cwd as the walk-up origin; no
 *      fall-through below it when it resolves to nothing).
 *   3. cwd walk-up.
 *   4. The validated harness backstop ({@link validatedHarnessProjectDir}),
 *      consulted only when walk-up from the anchor/cwd found nothing.
 */
export function getProjectConfig(): ProjectConfig | undefined {
  if (cached) return cached.value;

  const configDir = configDirOverride ?? process.env.ME_CONFIG_DIR ?? undefined;
  if (configDir) {
    const value = discoverProjectConfig(process.cwd(), configDir);
    cached = { value };
    return value;
  }

  const anchor = projectDirOverride ?? process.env.ME_PROJECT_DIR ?? undefined;
  let value = discoverProjectConfig(anchor ?? process.cwd());
  // The backstop is a LAST resort below both the anchor and cwd walk-up — an
  // explicit anchor that resolves to nothing must stay resolved to nothing,
  // never quietly replaced by a different (harness-var-derived) project.
  if (!value && anchor === undefined) {
    const backstop = validatedHarnessProjectDir();
    if (backstop) value = discoverProjectConfig(backstop);
  }
  cached = { value };
  return value;
}

/** Reset the memoized config + config-dir/project-dir overrides. Test-only. */
export function resetProjectConfigCache(): void {
  configDirOverride = undefined;
  projectDirOverride = undefined;
  cached = undefined;
}
