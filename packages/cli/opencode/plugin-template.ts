/**
 * The OpenCode capture plugin source, written by `me opencode init` into the
 * global plugin dir (`~/.config/opencode/plugins/`).
 *
 * It is deliberately tiny and dependency-free so it runs as a dropped-in local
 * plugin with no install step: on `session.idle` (per-turn-ish) and
 * `session.deleted` (final flush) it shells out — via the plugin context's Bun
 * `$` — to `me opencode hook`, which imports the session into Memory Engine.
 * Fire-and-forget and `.nothrow()`, so a capture never blocks or fails an
 * OpenCode session. All real logic (parsing, incremental dedup, credential
 * resolution) lives in the `me` CLI, consistent with the "require `me` on PATH,
 * don't bundle the binary" decision.
 */
import { DEFAULT_PRIVATE_TREE_ROOT } from "../importers/index.ts";

/** Marker (first line) identifying a file we manage, for idempotent re-init. */
export const PLUGIN_MARKER =
  "// memory-engine: OpenCode capture plugin (managed by `me opencode init`)";

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

/**
 * Render the plugin source. `treeRoot` adds `--tree-root <root>` only when it
 * differs from the hook's own default (the private `~/projects`), so the common
 * case stays flag-free; `fullTranscript` adds `--full-transcript`. The extra
 * args are emitted as a JS array and interpolated into the `$\`…\`` command as
 * `${...}`, so Bun `$` escapes each element — the tree root cannot break the
 * command or inject shell regardless of its contents. A non-default `treeRoot`
 * is also validated against `TREE_ROOT_SAFE` (throws) as an early sanity check.
 */
export function renderPluginSource(
  opts: { treeRoot?: string; fullTranscript?: boolean } = {},
): string {
  const extraArgs: string[] = [];
  if (opts.treeRoot && opts.treeRoot !== DEFAULT_PRIVATE_TREE_ROOT) {
    if (!TREE_ROOT_SAFE.test(opts.treeRoot)) {
      throw new Error(
        `invalid tree root ${JSON.stringify(opts.treeRoot)}: must match ${TREE_ROOT_SAFE}`,
      );
    }
    extraArgs.push("--tree-root", opts.treeRoot);
  }
  if (opts.fullTranscript) extraArgs.push("--full-transcript");
  // Emitted as a JS array literal and interpolated into the command below, so
  // Bun `$` escapes each element (empty array → no extra args).
  const argsLiteral = JSON.stringify(extraArgs);

  return `${PLUGIN_MARKER}
//
// Captures OpenCode sessions to Memory Engine. Regenerate with \`me opencode init\`.
// Requires the \`me\` CLI on PATH and a \`me login\` session (or ME_API_KEY + ME_SPACE).

export const MemoryEngine = async ({ $ }) => {
  // Extra args passed to every capture (empty in the common case). Interpolated
  // as an array so Bun \`$\` escapes each element — no shell-injection surface.
  const EXTRA_ARGS = ${argsLiteral}
  const capture = (eventName, sessionID) => {
    if (!sessionID) return
    // Fire-and-forget; .nothrow() + try/catch so a capture never breaks a session.
    try {
      $\`me opencode hook --event \${eventName} --session \${sessionID} \${EXTRA_ARGS}\`
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
    },
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
