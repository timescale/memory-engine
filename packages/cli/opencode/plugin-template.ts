/**
 * The OpenCode capture plugin source, written by `me opencode install` (user
 * scope, `~/.config/opencode/plugins/`) and `me opencode init` (project scope,
 * `.opencode/plugins/`).
 *
 * It is deliberately tiny and dependency-free so it runs as a dropped-in local
 * plugin with no install step: on `session.idle` (per-turn-ish) and
 * `session.deleted` (final flush) it shells out — via the plugin context's Bun
 * `$` — to `me opencode hook`, which imports the session into Memory Engine.
 * Fire-and-forget and `.nothrow()`, so a capture never blocks or fails an
 * OpenCode session. All real logic (parsing, incremental dedup, credential
 * resolution) lives in the `me` CLI, consistent with the "require `me` on PATH,
 * don't bundle the binary" decision.
 *
 * Scope shapes two things (HARNESS_INTEGRATION_DESIGN.md §3.2):
 *   - **project** scope bakes `--as-agent .me` into the hook command (captures
 *     write as the project's agent) AND exports a `shell.env` hook injecting
 *     `ME_AS_AGENT=.me` into every tool shell (so the agent's ad-hoc `me` calls
 *     run as the agent too — Tier-2).
 *   - **user** scope does neither (captures + shells run as the human).
 * The `--scope <scope>` flag on the hook command drives the double-capture
 * dedup when both scopes are installed (§5): the user-scope plugin defers when
 * the project-scope plugin is present.
 */
import type { HookScope } from "../agent/capture.ts";

/** Marker (first line) identifying a file we manage, for idempotent re-install.
 * Scope-neutral: the same marker is written by user- and project-scope installs
 * so either can recognize (and refresh/remove) the other's file. */
export const PLUGIN_MARKER =
  "// memory-engine: OpenCode capture plugin (managed by the `me` CLI)";

/** Default filename for the generated plugin. */
export const PLUGIN_FILENAME = "memory-engine.ts";

/**
 * Strict ltree-safe tree-root pattern, used as an input-sanity check at render
 * time (we reject obviously-wrong tree roots early rather than bake them in).
 * Mirrors the lenient wire form in `@memory.build/protocol` (`[A-Za-z0-9_~./-]`)
 * minus the empty string. Note this is *not* the injection defense — the value
 * is passed to Bun `$` as an interpolated array element, which Bun escapes.
 */
const TREE_ROOT_SAFE = /^[A-Za-z0-9_~./-]+$/;

export interface RenderPluginOptions {
  /** Install scope: "project" bakes agent mode + shell.env; "user" doesn't. */
  scope: HookScope;
  treeRoot?: string;
  fullTranscript?: boolean;
}

/**
 * Render the plugin source. The hook command is a static template literal (so
 * Bun `$` word-splits `--as-agent .me` / `--scope <scope>` normally); only
 * `treeRoot`/`fullTranscript` become interpolated `EXTRA_ARGS` (escaped by Bun
 * `$` — a tree root can't break the command or inject shell). A non-default
 * `treeRoot` is validated against `TREE_ROOT_SAFE` (throws) as a sanity check.
 */
export function renderPluginSource(opts: RenderPluginOptions): string {
  const project = opts.scope === "project";

  const extraArgs: string[] = [];
  if (opts.treeRoot && opts.treeRoot !== "share.projects") {
    if (!TREE_ROOT_SAFE.test(opts.treeRoot)) {
      throw new Error(
        `invalid tree root ${JSON.stringify(opts.treeRoot)}: must match ${TREE_ROOT_SAFE}`,
      );
    }
    extraArgs.push("--tree-root", opts.treeRoot);
  }
  if (opts.fullTranscript) extraArgs.push("--full-transcript");
  const argsLiteral = JSON.stringify(extraArgs);

  // Static command prefix (all literals — no user input): agent flag + scope.
  const asAgent = project ? "--as-agent .me " : "";
  const cmdPrefix = `me ${asAgent}opencode hook --scope ${opts.scope}`;

  // Tier-2: project scope injects ME_AS_AGENT into every tool shell.
  const shellEnvHook = project
    ? `
    // Tier-2: run the agent's ad-hoc \`me\` calls as the project agent too.
    "shell.env": async (_input, output) => {
      output.env.ME_AS_AGENT = ".me"
    },`
    : "";

  return `${PLUGIN_MARKER}
//
// Captures OpenCode sessions to Memory Engine. Regenerate with \`me opencode ${project ? "init" : "install"}\`.
// Requires the \`me\` CLI on PATH and a \`me login\` session (or ME_API_KEY + ME_SPACE).

export const MemoryEngine = async ({ $ }) => {
  // Extra args passed to every capture (empty in the common case). Interpolated
  // as an array so Bun \`$\` escapes each element — no shell-injection surface.
  const EXTRA_ARGS = ${argsLiteral}
  const capture = (eventName, sessionID) => {
    if (!sessionID) return
    // Fire-and-forget; .nothrow() + try/catch so a capture never breaks a session.
    try {
      $\`${cmdPrefix} --event \${eventName} --session \${sessionID} \${EXTRA_ARGS}\`
        .quiet()
        .nothrow()
    } catch {}
  }
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        capture("idle", event.properties?.sessionID)
      } else if (event.type === "session.deleted") {
        capture("deleted", event.properties?.info?.id)
      }
    },${shellEnvHook}
    // Nudge the post-compaction continuation to reload project memory. Harmless
    // on opencode builds that don't support this experimental hook (uncalled).
    "experimental.session.compacting": async (_input, output) => {
      output.context.push(
        "Project context is stored in Memory Engine. Before continuing, recall" +
          " relevant prior decisions and history with the \`me_memory_search\` tool.",
      )
    },
  }
}
`;
}
