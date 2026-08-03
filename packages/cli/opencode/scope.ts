/**
 * OpenCode install scope — where `me opencode install` / `init` write the
 * plugin, commands, skills, and MCP config.
 *
 * - "project": under the repo root, so the integration can be committed and
 *   shared with a team (`.opencode/{plugins,commands,skills}/` + `opencode.json`).
 * - "user": the global `~/.config/opencode/` config (the original behavior).
 *
 * OpenCode discovers both (global config + project config/`.opencode/`), with
 * project taking precedence.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { InvalidArgumentError } from "commander";

export type OpenCodeScope = "project" | "user";
export const OPENCODE_SCOPES: OpenCodeScope[] = ["project", "user"];

/**
 * Validate a `--scope` value. Returns undefined when unset (so callers can
 * apply their own default), throws `InvalidArgumentError` on an unknown value.
 */
export function parseScope(
  value: string | undefined,
): OpenCodeScope | undefined {
  if (value === undefined) return undefined;
  if (value === "project" || value === "user") return value;
  throw new InvalidArgumentError(
    `scope must be one of: ${OPENCODE_SCOPES.join(", ")}`,
  );
}

/**
 * Base config dir for a scope: project → `<projectRoot>/.opencode`, user → the
 * global `~/.config/opencode`. Plugins/commands/skills live under it.
 */
export function openCodeBaseDir(
  scope: OpenCodeScope,
  projectRoot: string,
): string {
  return scope === "project"
    ? join(projectRoot, ".opencode")
    : join(homedir(), ".config", "opencode");
}

export const openCodePluginsDir = (
  scope: OpenCodeScope,
  projectRoot: string,
): string => join(openCodeBaseDir(scope, projectRoot), "plugins");

export const openCodeCommandsDir = (
  scope: OpenCodeScope,
  projectRoot: string,
): string => join(openCodeBaseDir(scope, projectRoot), "commands");

export const openCodeSkillsDir = (
  scope: OpenCodeScope,
  projectRoot: string,
): string => join(openCodeBaseDir(scope, projectRoot), "skills");
