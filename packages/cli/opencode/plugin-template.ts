/**
 * The OpenCode capture plugin source, written by `me opencode init` into the
 * user's plugin dir (`~/.config/opencode/plugins/` or `.opencode/plugins/`).
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

/** Marker (first line) identifying a file we manage, for idempotent re-init. */
export const PLUGIN_MARKER =
  "// memory-engine: OpenCode capture plugin (managed by `me opencode init`)";

/** Default filename for the generated plugin. */
export const PLUGIN_FILENAME = "memory-engine.ts";

/**
 * Render the plugin source. `treeRoot` is appended as a `--tree-root` flag only
 * when it differs from the hook's own default (`share.projects`), so the common
 * case stays flag-free; `fullTranscript` adds `--full-transcript`.
 */
export function renderPluginSource(
  opts: { treeRoot?: string; fullTranscript?: boolean } = {},
): string {
  const flags: string[] = [];
  if (opts.treeRoot && opts.treeRoot !== "share.projects") {
    flags.push(`--tree-root ${opts.treeRoot}`);
  }
  if (opts.fullTranscript) flags.push("--full-transcript");
  // Extra flags are spliced into the tagged-template command as static args.
  const extra = flags.length ? ` ${flags.join(" ")}` : "";

  return `${PLUGIN_MARKER}
//
// Captures OpenCode sessions to Memory Engine. Regenerate with \`me opencode init\`.
// Requires the \`me\` CLI on PATH and a \`me login\` session (or ME_API_KEY + ME_SPACE).

export const MemoryEngine = async ({ $ }) => {
  const capture = (eventName, sessionID) => {
    if (!sessionID) return
    // Fire-and-forget; .nothrow() + try/catch so a capture never breaks a session.
    try {
      $\`me opencode hook --event \${eventName} --session \${sessionID}${extra}\`
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
