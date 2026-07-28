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
 *
 * It also carries the harness-injected environment contract via a
 * `shell.env` hook: every shell command OpenCode runs gets `ME_PROJECT_DIR`
 * (the session-scoped `directory`, verbatim — deliberately NOT the
 * per-command `input.cwd`, so a `workdir=/tmp` excursion keeps discovery)
 * and inert `AI_AGENT` metadata, so a plain `me` call from OpenCode's shell
 * tool always resolves the right project. The constants are baked in as
 * literals at generation time (this file has no
 * runtime dependency on `../harness-contract.ts` — the generated source stays
 * dependency-free).
 */
import { AI_AGENT_VAR, ME_PROJECT_DIR_VAR } from "../harness-contract.ts";

/**
 * Marker (first line) identifying a file we manage, for idempotent re-init.
 * Bump the trailing version when the template changes in a way `me opencode
 * install`/`init` should treat an existing install as stale (e.g. the
 * `shell.env` hook addition) — a mismatched marker makes the plugin-install
 * step report "available" again instead of "done".
 */
export const PLUGIN_MARKER =
  "// memory-engine: OpenCode capture plugin (managed by `me opencode init`) v4";

/** Default filename for the generated plugin. */
export const PLUGIN_FILENAME = "memory-engine.ts";

/**
 * Render the plugin source. `fullTranscript` adds `--full-transcript`. There
 * is deliberately no tree knob: tree routing is `.me` config (else the
 * machine-wide `tree_root` / private default), never a baked plugin value.
 * The extra args are emitted as a JS array and interpolated into the
 * `$\`…\`` command as `${...}`, so Bun `$` escapes each element.
 */
export function renderPluginSource(
  opts: { fullTranscript?: boolean } = {},
): string {
  const extraArgs: string[] = [];
  if (opts.fullTranscript) extraArgs.push("--full-transcript");
  // Emitted as a JS array literal and interpolated into the command below, so
  // Bun `$` escapes each element (empty array → no extra args).
  const argsLiteral = JSON.stringify(extraArgs);

  return `${PLUGIN_MARKER}
//
// Captures OpenCode sessions to Memory Engine. Regenerate with \`me opencode init\`.
// Requires the \`me\` CLI on PATH and a \`me login\` session (or ME_API_KEY + ME_SPACE).

export const MemoryEngine = async ({ $, directory }) => {
  // Extra args passed to every capture (empty in the common case). Interpolated
  // as an array so Bun \`$\` escapes each element — no shell-injection surface.
  const EXTRA_ARGS = ${argsLiteral}
  const capture = (eventName, sessionID) => {
    if (!sessionID) return
    // Fire-and-forget; .nothrow() + try/catch so a capture never breaks a session.
    // --project-dir anchors .me/config.yaml discovery on the session's own
    // directory, explicitly — not an inferred process.cwd() of the shelled-out
    // process.
    try {
      $\`me opencode hook --event \${eventName} --session \${sessionID} --project-dir \${directory} \${EXTRA_ARGS}\`
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
    // Every shell command gets the project-discovery anchor and inert harness
    // metadata. These identify routing only; they never alter credentials.
    "shell.env": async (_input, output) => {
      output.env = {
        ...output.env,
        ${AI_AGENT_VAR}: "opencode",
        ${ME_PROJECT_DIR_VAR}: directory,
      }
    },
  }
}
`;
}
