/** Native Gemini CLI installation adapter. Public command wiring is separate. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  HarnessInstallation,
  InstallationArtifact,
} from "../harness/installations.ts";
import {
  type JsonHookEntry,
  upsertJsonHooksFile,
} from "../harness-hooks-json.ts";
import {
  buildMeCommand,
  type InstallResult,
  installMcpServer,
  MCP_TOOLS,
} from "../mcp/install.ts";

const GEMINI_ENV_HOOK_COMMAND = "me gemini env-hook";
const GEMINI_HOOK_ENTRY: JsonHookEntry = {
  matcher: "run_shell_command",
  hooks: [{ type: "command", command: GEMINI_ENV_HOOK_COMMAND }],
};

export interface GeminiIntegrationResult {
  artifacts: InstallationArtifact[];
  messages: string[];
}

export interface GeminiUninstallResult {
  removed: InstallationArtifact[];
  retained: InstallationArtifact[];
  messages: string[];
}

export function geminiSettingsPath(): string {
  return join(homedir(), ".gemini", "settings.json");
}

function geminiMcpTool() {
  const tool = MCP_TOOLS.find((candidate) => candidate.bin === "gemini");
  if (!tool || tool.method !== "cli") {
    throw new Error("Gemini CLI MCP installer is unavailable.");
  }
  return tool;
}

/** Exact native command used for the user-global dormant MCP registration. */
export function geminiMcpAddCommand(): string[] {
  return geminiMcpTool().addCmd(buildMeCommand({}), { scope: "user" });
}

function hookArtifact(path: string): InstallationArtifact {
  return {
    kind: "json-hook",
    path,
    event: "BeforeTool",
    command: GEMINI_ENV_HOOK_COMMAND,
  };
}

export function installGeminiEnvHook(path = geminiSettingsPath()): boolean {
  return upsertJsonHooksFile(
    path,
    "BeforeTool",
    GEMINI_HOOK_ENTRY,
    GEMINI_ENV_HOOK_COMMAND,
  ).changed;
}

/** Remove precisely our hook entry, retaining all other Gemini settings. */
export function uninstallGeminiEnvHook(path = geminiSettingsPath()): boolean {
  if (!existsSync(path)) return false;
  const root: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const settings = root as Record<string, unknown>;
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const hookSettings = hooks as Record<string, unknown>;
  const entries = hookSettings.BeforeTool;
  if (!Array.isArray(entries)) return false;
  const remaining = entries.filter(
    (entry) =>
      !(
        entry &&
        typeof entry === "object" &&
        Array.isArray((entry as { hooks?: unknown }).hooks) &&
        (entry as { hooks: Array<{ command?: unknown }> }).hooks.some(
          (hook) => hook?.command === GEMINI_ENV_HOOK_COMMAND,
        )
      ),
  );
  if (remaining.length === entries.length) return false;
  writeFileSync(
    path,
    `${JSON.stringify(
      { ...settings, hooks: { ...hookSettings, BeforeTool: remaining } },
      null,
      2,
    )}\n`,
  );
  return true;
}

export async function installGeminiIntegration(
  settingsPath = geminiSettingsPath(),
  installMcp: () => Promise<InstallResult> = () =>
    installMcpServer(geminiMcpTool(), buildMeCommand({}), {
      scope: "user",
      replaceExisting: false,
    }),
): Promise<GeminiIntegrationResult> {
  const result = await installMcp();
  if (!result.success) throw new Error(result.message);

  const artifacts: InstallationArtifact[] = [];
  if (!result.preserved) {
    artifacts.push({ kind: "mcp-cli", server_name: "me", scope: "user" });
  }
  if (installGeminiEnvHook(settingsPath))
    artifacts.push(hookArtifact(settingsPath));
  return { artifacts, messages: [result.message] };
}

export async function uninstallGeminiIntegration(
  record: HarnessInstallation,
  removeMcp: () => Promise<boolean> = async () => {
    const process = Bun.spawn(geminiMcpTool().removeCmd({ scope: "user" }), {
      stdout: "pipe",
      stderr: "pipe",
    });
    return (await process.exited) === 0;
  },
): Promise<GeminiUninstallResult> {
  const removed: InstallationArtifact[] = [];
  const retained: InstallationArtifact[] = [];
  const messages: string[] = [];
  for (const artifact of record.artifacts) {
    if (artifact.kind === "mcp-cli") {
      if (artifact.scope !== "user") {
        retained.push(artifact);
        messages.push("Retained non-user Gemini MCP artifact.");
        continue;
      }
      if (await removeMcp()) {
        removed.push(artifact);
        messages.push("Removed Gemini MCP registration.");
      } else {
        retained.push(artifact);
        messages.push(
          "Retained Gemini MCP registration: provider removal failed.",
        );
      }
    } else if (artifact.kind === "json-hook") {
      try {
        uninstallGeminiEnvHook(artifact.path);
        removed.push(artifact);
        messages.push("Removed Gemini BeforeTool hook.");
      } catch (error) {
        retained.push(artifact);
        messages.push(
          `Retained Gemini BeforeTool hook: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      retained.push(artifact);
      messages.push(`Retained incompatible Gemini artifact: ${artifact.kind}.`);
    }
  }
  return { removed, retained, messages };
}
