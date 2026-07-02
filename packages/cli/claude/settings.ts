/**
 * Claude Code `settings.json` shaping for the memory-engine integration.
 *
 * Claude captures via hooks declared in settings.json (`~/.claude/settings.json`
 * at user scope, `.claude/settings.json` at project scope), and injects tool-
 * shell env vars via the same file's `env` object. Hooks MERGE across scopes
 * (P0-verified) — user + project both run — so we own only our named entries
 * and dedup by scope with the `--scope` flag on the hook command (design §5).
 *
 * Pure functions (upsert/remove/detect) so they unit-test without I/O; the
 * command layers `updateJsonFile` on top.
 */
import type { HookScope } from "../agent/capture.ts";

/** The two capture events we register (Stop = per-turn, SessionEnd = flush). */
const HOOK_EVENTS = ["Stop", "SessionEnd"] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

/** Map a Claude event name to our `--event` flag value. */
const EVENT_FLAG: Record<HookEvent, string> = {
  Stop: "stop",
  SessionEnd: "session-end",
};

/** The env var we inject at project scope (Tier-2). */
export const ENV_KEY = "ME_AS_AGENT";
export const ENV_VALUE = ".me";

/** The hook command string for a scope + event. Project scope bakes agent
 * mode; both carry `--scope` for the double-capture dedup. */
export function hookCommand(scope: HookScope, event: HookEvent): string {
  const me = scope === "project" ? "me --as-agent .me" : "me";
  return `${me} claude hook --scope ${scope} --event ${EVENT_FLAG[event]}`;
}

/** A single hook handler entry (Claude's `type: "command"` shape). */
interface HookHandler {
  type?: string;
  command?: string;
  timeout?: number;
  async?: boolean;
}
/** A matcher-group: an optional matcher + its handlers. */
interface HookGroup {
  matcher?: string;
  hooks?: HookHandler[];
}

/** Whether a handler is one of ours (its command runs `me … claude hook …`). */
function handlerIsOurs(h: unknown): boolean {
  const cmd = (h as HookHandler)?.command;
  return typeof cmd === "string" && /\bclaude hook\b/.test(cmd);
}

/** Whether a matcher-group contains our handler. */
function groupIsOurs(g: unknown): boolean {
  const hooks = (g as HookGroup)?.hooks;
  return Array.isArray(hooks) && hooks.some(handlerIsOurs);
}

/** Our managed matcher-group for an event. `SessionEnd` defaults to a 1.5s
 * timeout upstream, so we always pin an explicit 60. */
function ourGroup(scope: HookScope, event: HookEvent): HookGroup {
  return {
    hooks: [
      {
        type: "command",
        command: hookCommand(scope, event),
        async: true,
        timeout: 60,
      },
    ],
  };
}

type Settings = Record<string, unknown>;

/** Read the `hooks` object as event → matcher-group[] (fresh, mutable). */
function readHooks(settings: Settings): Record<string, HookGroup[]> {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return {};
  const out: Record<string, HookGroup[]> = {};
  for (const [k, v] of Object.entries(hooks as Record<string, unknown>)) {
    if (Array.isArray(v)) out[k] = [...(v as HookGroup[])];
  }
  return out;
}

/**
 * Upsert our capture hooks (and, at project scope, `env.ME_AS_AGENT`) into a
 * settings object. Idempotent: replaces our prior entries in place, preserves
 * every foreign hook and env var.
 */
export function upsertClaudeSettings(
  settings: Settings,
  opts: { scope: HookScope },
): Settings {
  const next: Settings = { ...settings };
  const hooks = readHooks(settings);
  for (const event of HOOK_EVENTS) {
    const kept = (hooks[event] ?? []).filter((g) => !groupIsOurs(g));
    kept.push(ourGroup(opts.scope, event));
    hooks[event] = kept;
  }
  next.hooks = hooks;

  if (opts.scope === "project") {
    const env =
      settings.env && typeof settings.env === "object"
        ? { ...(settings.env as Record<string, unknown>) }
        : {};
    env[ENV_KEY] = ENV_VALUE;
    next.env = env;
  }
  return next;
}

/**
 * Remove our managed entries: our hook groups from every event (dropping an
 * event key that becomes empty, and `hooks` if it empties), and our
 * `env.ME_AS_AGENT` (only when it's still our value). Leaves foreign content
 * untouched.
 */
export function removeClaudeSettings(settings: Settings): Settings {
  const next: Settings = { ...settings };
  const hooks = readHooks(settings);
  for (const event of Object.keys(hooks)) {
    const kept = hooks[event]?.filter((g) => !groupIsOurs(g)) ?? [];
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;

  if (settings.env && typeof settings.env === "object") {
    const env = { ...(settings.env as Record<string, unknown>) };
    if (env[ENV_KEY] === ENV_VALUE) delete env[ENV_KEY];
    if (Object.keys(env).length > 0) next.env = env;
    else delete next.env;
  }
  return next;
}

/** Whether a settings object carries our managed capture hooks. */
export function claudeSettingsHasCapture(settings: Settings): boolean {
  const hooks = readHooks(settings);
  return Object.values(hooks).some((groups) => groups.some(groupIsOurs));
}
