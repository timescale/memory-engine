/**
 * Shared capture-hook runner — the one implementation behind every
 * `me <harness> hook` command.
 *
 * Capture is the import path: a harness lifecycle event hands us a transcript
 * file, and we run it through `importTranscriptFile` (same parse + write as
 * `me import <harness>`, incremental + idempotent). Per-harness hook commands
 * are thin adapters: parse the harness's event payload into a transcript path
 * (+ session cwd), pick the importer, and call {@link runCaptureHook}.
 *
 * Semantics (design: HARNESS_INTEGRATION_DESIGN.md §2/§5):
 *
 * - **Best-effort, never throws.** Failures log to stderr with a
 *   `[memory-engine]` prefix; the caller always exits 0 so a capture problem
 *   never blocks or fails a harness session.
 * - **Scope dedup.** Hooks/plugins MERGE across user + project config on
 *   Claude/Codex/OpenCode — with both scopes installed, both hooks fire. Every
 *   authored hook command carries `--scope user|project`; a `--scope user`
 *   invocation defers (logs + returns) when the same harness's project-scope
 *   capture artifact is installed in the event's project. Deferral keys on
 *   artifact presence — NOT on `.me` presence — so a project with a `.me` but
 *   no project-scope install still gets user-scope (human) captures.
 * - **Identity.** Project scope invocations arrive as `me --as-agent .me …`,
 *   so `resolveCredentials()` already carries `asAgent`; user scope carries
 *   none. This module doesn't decide identity — the authored command does.
 * - **Routing.** Credential resolution is pinned to the SESSION's project
 *   (`setConfigDirOverride`), not the hook process cwd, so a `.me/config.yaml`
 *   in the project routes captures deterministically.
 */
import * as path from "node:path";
import { createMemoryClient } from "../client.ts";
import {
  type ResolvedCredentials,
  resolveCredentials,
} from "../credentials.ts";
import {
  DEFAULT_SESSIONS_NODE_NAME,
  DEFAULT_TREE_ROOT,
  type Importer,
  importTranscriptFile,
} from "../importers/index.ts";
import { SlugRegistry } from "../importers/slug.ts";
import {
  discoverProjectConfig,
  setConfigDirOverride,
} from "../project-config.ts";
import { memoryBearer } from "../session.ts";

export const DEFAULT_SERVER = "https://api.memory.build";

/** The install scope a hook invocation was authored for. */
export type HookScope = "user" | "project";
export const HOOK_SCOPES: HookScope[] = ["user", "project"];

/** Parse a `--scope` value; undefined falls back to "user" (safe: user scope
 * is the deferring side, so a scope-less legacy invocation never double-runs
 * against a project install). */
export function parseHookScope(value: unknown): HookScope {
  return value === "project" ? "project" : "user";
}

/** Resolved hook config: where + how to write captured memories. */
export interface HookConfig {
  server: string;
  /** Explicit api key bearer; undefined → the `me login` session at send time. */
  apiKey?: string;
  /** Active space slug (X-Me-Space). */
  space: string;
  /** Parent tree for slug-nested captures (`<treeRoot>.<slug>.…`). */
  treeRoot: string;
  /** Full project tree from `.me/config.yaml` (no slug appended) — wins. */
  projectTree?: string;
  fullTranscript: boolean;
  /** Act-as-agent target (X-Me-As-Agent), from `--as-agent`/`ME_AS_AGENT`. */
  asAgent?: string;
}

/** The slice of resolved credentials the hook needs (pure/testable). */
export type HookCreds = Pick<
  ResolvedCredentials,
  "server" | "apiKey" | "activeSpace" | "loggedIn" | "projectTree" | "asAgent"
>;

/** Optional knobs the authored hook command passes through. */
export interface HookConfigInput {
  treeRoot?: string;
  fullTranscript?: boolean;
}

/** Treat unset / empty / unsubstituted-placeholder values as missing. */
function blank(v: string | undefined): boolean {
  return !v || /^\$\{.*\}$/.test(v);
}

/**
 * Resolve the hook config from credentials plus optional flags. Bearer: an
 * explicit api key, else the login session (resolved at send time by
 * `memoryBearer`). Returns null when no bearer or no space is available.
 */
export function resolveHookConfig(
  creds: HookCreds,
  input: HookConfigInput = {},
): HookConfig | null {
  if (!creds.apiKey && !creds.loggedIn) return null;
  const space = creds.activeSpace;
  if (!space) return null;

  const server = creds.server || DEFAULT_SERVER;
  // An explicit --tree-root (parent+slug layout) wins; else the `.me` project
  // tree is the full project node (no slug); else the default parent+slug.
  const pinnedTreeRoot = blank(input.treeRoot) ? undefined : input.treeRoot;
  return {
    server,
    apiKey: creds.apiKey,
    space,
    treeRoot: pinnedTreeRoot ?? DEFAULT_TREE_ROOT,
    projectTree: pinnedTreeRoot ? undefined : creds.projectTree,
    fullTranscript: input.fullTranscript ?? false,
    asAgent: creds.asAgent,
  };
}

/** What a per-harness hook command hands the shared runner. */
export interface CaptureHookSpec {
  /** Harness name for log prefixes (e.g. "claude"). */
  harness: string;
  /** Event name for log prefixes (e.g. "stop"). */
  event: string;
  /** Which install scope authored this invocation (`--scope`). */
  scope: HookScope;
  /** Absolute path to the session transcript to import. */
  transcriptPath: string;
  /** The session's project dir (event `cwd`); default `process.cwd()`. Drives
   * `.me` discovery, credential routing, and the dedup detection root. */
  projectCwd?: string;
  /** The harness's transcript importer (must support `parseFile`). */
  importer: Importer;
  /**
   * Detects this harness's PROJECT-scope capture artifact at the given project
   * root (git root, else the session cwd) — the dedup gate for `scope: "user"`
   * invocations. Omit for harnesses without the double-fire problem.
   */
  projectCaptureInstalled?: (projectRoot: string) => Promise<boolean>;
  /** Pass-through knobs (`--tree-root`, `--full-transcript`). */
  input?: HookConfigInput;
}

/** Log a hook-side message to stderr (never stdout — stdio may be a protocol
 * channel for the harness). */
function log(spec: { harness: string; event: string }, msg: string): void {
  console.error(`[memory-engine] ${spec.harness} ${spec.event}: ${msg}`);
}

/**
 * Run one capture. Never throws; resolves when the capture completed, was
 * skipped (no credentials / deferred), or failed (logged). The caller should
 * `process.exit(0)` afterwards regardless.
 */
export async function runCaptureHook(spec: CaptureHookSpec): Promise<void> {
  try {
    const cwd = spec.projectCwd ?? process.cwd();

    // Scope dedup: a user-scope invocation defers to an installed
    // project-scope capture for the same harness.
    if (spec.scope === "user" && spec.projectCaptureInstalled) {
      const { gitRoot } = await new SlugRegistry().resolve(cwd);
      const projectRoot = gitRoot ?? cwd;
      if (await spec.projectCaptureInstalled(path.resolve(projectRoot))) {
        log(spec, "project-scope capture installed here — deferring");
        return;
      }
    }

    // Pin credential resolution to the SESSION's project `.me`, not the hook
    // process cwd. A broken `.me` is fatal for direct CLI use, but capture is
    // best-effort: log + return so a typo never blocks a session.
    const project = discoverProjectConfig(cwd);
    if (project) setConfigDirOverride(project.dir);
    const config = resolveHookConfig(resolveCredentials(), spec.input);
    if (!config) {
      log(
        spec,
        "no credentials — run `me login` (or set ME_API_KEY + ME_SPACE); skipping capture",
      );
      return;
    }

    const client = createMemoryClient({
      url: config.server,
      ...memoryBearer(config.server, config.apiKey),
      space: config.space,
      asAgent: config.asAgent,
    });
    await importTranscriptFile(client, spec.importer, spec.transcriptPath, {
      treeRoot: config.treeRoot,
      projectTree: config.projectTree,
      sessionsNodeName: DEFAULT_SESSIONS_NODE_NAME,
      fullTranscript: config.fullTranscript,
      dryRun: false,
      verbose: false,
    });
  } catch (error) {
    log(spec, error instanceof Error ? error.message : String(error));
  }
}
