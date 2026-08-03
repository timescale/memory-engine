/** Render the global, dependency-free OpenCode dormant plugin. */
import { AI_AGENT_VAR, ME_PROJECT_DIR_VAR } from "../harness-contract.ts";

export const PLUGIN_MARKER =
  "// memory-engine: OpenCode dormant plugin (managed by `me opencode install`) v5";
export const PLUGIN_FILENAME = "memory-engine.ts";

/** Capture policy is resolved at runtime from the session directory. */
export function renderPluginSource(): string {
  return `${PLUGIN_MARKER}
// Dormant OpenCode capture and shell-contract plumbing for Memory Engine.

export const MemoryEngine = async ({ $, directory }) => {
  const capture = (eventName, sessionID) => {
    if (!sessionID) return
    try {
      $\`me opencode hook --event \${eventName} --session \${sessionID} --project-dir \${directory}\`
        .quiet()
        .nothrow()
    } catch {}
  }
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") capture("idle", event.properties?.sessionID)
      else if (event.type === "session.deleted") capture("deleted", event.properties?.info?.id)
    },
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
