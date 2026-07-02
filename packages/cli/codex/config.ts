/**
 * Codex config shaping for the memory-engine integration.
 *
 * Codex splits across two files (P0-verified against developers.openai.com/codex):
 *   - `config.toml` (`~/.codex/` user, `.codex/` project, trust-gated) — the MCP
 *     server (`[mcp_servers.me]`) and, at project scope, the Tier-2 shell env
 *     injection (`[shell_environment_policy] set`). We manage a single
 *     marker-delimited TOML block here rather than parse/serialize the whole
 *     file (no TOML dependency). Caveat: if the user already defines their own
 *     top-level `[shell_environment_policy]`, TOML forbids the duplicate table —
 *     documented limitation (rare).
 *   - `hooks.json` (JSON) — capture hooks. Codex's turn-end event is `Stop`
 *     (there is no SessionEnd); timeouts are in SECONDS. Hooks merge across
 *     layers, so we dedup with `--scope` like the other harnesses (§5).
 *
 * Pure functions here; the command layers file I/O on top.
 */
import type { HookScope } from "../agent/capture.ts";
import { hashMarkers } from "../agent/managed.ts";

/** Managing-command marker for the TOML block (harness-agnostic per scope). */
const tomlManagedBy = (scope: HookScope): string =>
  scope === "project" ? "me init" : "me install";

export const codexTomlMarkers = (scope: HookScope) =>
  hashMarkers(tomlManagedBy(scope));

/** TOML-encode a simple ASCII string value (double-quoted, like JSON). */
const tomlStr = (s: string): string => JSON.stringify(s);

/**
 * Render the managed `config.toml` block: `[mcp_servers.me]` (+ agent mode at
 * project scope via the baked `meCmd`), and at project scope the
 * `[shell_environment_policy]` that injects `ME_AS_AGENT=.me` into the agent's
 * tool shells (Tier-2). `meCmd` is a `buildMeCommand(...)` array (command +
 * args); element 0 is the command, the rest are args.
 */
export function renderCodexTomlBlock(
  scope: HookScope,
  meCmd: string[],
): string {
  const [command, ...args] = meCmd;
  const markers = codexTomlMarkers(scope);
  const lines = [
    markers.start,
    "[mcp_servers.me]",
    `command = ${tomlStr(command ?? "me")}`,
    `args = [${args.map(tomlStr).join(", ")}]`,
  ];
  if (scope === "project") {
    lines.push(
      "",
      "[shell_environment_policy]",
      `set = { ME_AS_AGENT = ${tomlStr(".me")} }`,
    );
  }
  lines.push(markers.end, "");
  return lines.join("\n");
}

// =============================================================================
// hooks.json (JSON)
// =============================================================================

/** Codex capture command for a scope (project bakes agent mode + `--scope`). */
export function codexHookCommand(scope: HookScope): string {
  const me = scope === "project" ? "me --as-agent .me" : "me";
  return `${me} codex hook --scope ${scope} --event stop`;
}

interface HookHandler {
  type?: string;
  command?: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookHandler[];
}
type HooksFile = Record<string, unknown>;

function handlerIsOurs(h: unknown): boolean {
  const cmd = (h as HookHandler)?.command;
  return typeof cmd === "string" && /\bcodex hook\b/.test(cmd);
}
function groupIsOurs(g: unknown): boolean {
  const hooks = (g as HookGroup)?.hooks;
  return Array.isArray(hooks) && hooks.some(handlerIsOurs);
}

/** Upsert our `Stop` capture hook into a Codex hooks.json object. Idempotent;
 * preserves foreign hooks. Timeout is in seconds (Codex convention). */
export function upsertCodexHooks(
  file: HooksFile,
  opts: { scope: HookScope },
): HooksFile {
  const next: HooksFile = { ...file };
  const hooksVal = file.hooks;
  const hooks: Record<string, HookGroup[]> =
    hooksVal && typeof hooksVal === "object" && !Array.isArray(hooksVal)
      ? { ...(hooksVal as Record<string, HookGroup[]>) }
      : {};
  const stop = Array.isArray(hooks.Stop)
    ? (hooks.Stop as HookGroup[]).filter((g) => !groupIsOurs(g))
    : [];
  stop.push({
    hooks: [
      { type: "command", command: codexHookCommand(opts.scope), timeout: 60 },
    ],
  });
  hooks.Stop = stop;
  next.hooks = hooks;
  return next;
}

/** Remove our managed hook(s); drop empties. */
export function removeCodexHooks(file: HooksFile): HooksFile {
  const next: HooksFile = { ...file };
  const hooksVal = file.hooks;
  if (!hooksVal || typeof hooksVal !== "object" || Array.isArray(hooksVal)) {
    return next;
  }
  const hooks: Record<string, HookGroup[]> = {
    ...(hooksVal as Record<string, HookGroup[]>),
  };
  for (const event of Object.keys(hooks)) {
    const kept = (hooks[event] ?? []).filter((g) => !groupIsOurs(g));
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

/** Whether a hooks.json object carries our managed capture hook. */
export function codexHooksHasCapture(file: HooksFile): boolean {
  const hooksVal = file.hooks;
  if (!hooksVal || typeof hooksVal !== "object" || Array.isArray(hooksVal)) {
    return false;
  }
  return Object.values(hooksVal as Record<string, HookGroup[]>).some(
    (groups) => Array.isArray(groups) && groups.some(groupIsOurs),
  );
}
