/**
 * Gemini CLI `settings.json` shaping for the memory-engine integration.
 *
 * Gemini keeps both the MCP server (`mcpServers.me`) and capture hooks
 * (`hooks`) in settings.json (`~/.gemini/settings.json` user, `.gemini/
 * settings.json` project). We write the MCP entry as JSON directly (rather than
 * via `gemini mcp add`) so a leading `--as-agent` arg can't be misparsed by the
 * CLI's own option parser, and so no binary is required. Capture events are
 * `AfterAgent` (per-turn — the reliable point) + `SessionEnd` (best-effort);
 * timeouts are in MILLISECONDS. Tier-2 env goes in `.gemini/.env`, not here.
 *
 * Pure functions; the command layers file I/O on top.
 */
import type { HookScope } from "../agent/capture.ts";

const HOOK_EVENTS = ["AfterAgent", "SessionEnd"] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];
const EVENT_FLAG: Record<HookEvent, string> = {
  AfterAgent: "after-agent",
  SessionEnd: "session-end",
};

/** Gemini capture command for a scope + event. */
export function geminiHookCommand(scope: HookScope, event: HookEvent): string {
  const me = scope === "project" ? "me --as-agent .me" : "me";
  return `${me} gemini hook --scope ${scope} --event ${EVENT_FLAG[event]}`;
}

type Settings = Record<string, unknown>;
interface HookHandler {
  type?: string;
  command?: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookHandler[];
}

function handlerIsOurs(h: unknown): boolean {
  const cmd = (h as HookHandler)?.command;
  return typeof cmd === "string" && /\bgemini hook\b/.test(cmd);
}
function groupIsOurs(g: unknown): boolean {
  const hooks = (g as HookGroup)?.hooks;
  return Array.isArray(hooks) && hooks.some(handlerIsOurs);
}

function readHooks(settings: Settings): Record<string, HookGroup[]> {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return {};
  const out: Record<string, HookGroup[]> = {};
  for (const [k, v] of Object.entries(hooks as Record<string, unknown>)) {
    if (Array.isArray(v)) out[k] = [...(v as HookGroup[])];
  }
  return out;
}

/** Upsert our AfterAgent + SessionEnd capture hooks (idempotent; preserves
 * foreign hooks). Timeout in ms. */
export function upsertGeminiHooks(
  settings: Settings,
  opts: { scope: HookScope },
): Settings {
  const next: Settings = { ...settings };
  const hooks = readHooks(settings);
  for (const event of HOOK_EVENTS) {
    const kept = (hooks[event] ?? []).filter((g) => !groupIsOurs(g));
    kept.push({
      hooks: [
        {
          type: "command",
          command: geminiHookCommand(opts.scope, event),
          timeout: 60000,
        },
      ],
    });
    hooks[event] = kept;
  }
  next.hooks = hooks;
  return next;
}

export function removeGeminiHooks(settings: Settings): Settings {
  const next: Settings = { ...settings };
  const hooks = readHooks(settings);
  for (const event of Object.keys(hooks)) {
    const kept = (hooks[event] ?? []).filter((g) => !groupIsOurs(g));
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

export function geminiHooksHasCapture(settings: Settings): boolean {
  return Object.values(readHooks(settings)).some((groups) =>
    groups.some(groupIsOurs),
  );
}

// =============================================================================
// mcpServers.me
// =============================================================================

/** Set `mcpServers.me` from a `buildMeCommand(...)` array (command + args). */
export function upsertGeminiMcp(settings: Settings, meCmd: string[]): Settings {
  const next: Settings = { ...settings };
  const [command, ...args] = meCmd;
  const servers =
    settings.mcpServers &&
    typeof settings.mcpServers === "object" &&
    !Array.isArray(settings.mcpServers)
      ? { ...(settings.mcpServers as Record<string, unknown>) }
      : {};
  servers.me = { command: command ?? "me", args };
  next.mcpServers = servers;
  return next;
}

/** Remove our `mcpServers.me` entry (dropping an emptied `mcpServers`). */
export function removeGeminiMcp(settings: Settings): Settings {
  const next: Settings = { ...settings };
  const servers = settings.mcpServers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    const copy = { ...(servers as Record<string, unknown>) };
    delete copy.me;
    if (Object.keys(copy).length > 0) next.mcpServers = copy;
    else delete next.mcpServers;
  }
  return next;
}
