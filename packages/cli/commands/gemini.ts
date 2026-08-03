/** Gemini CLI's user-global dormant MCP and shell-contract integration. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { CLIENT_VERSION } from "../../../version";
import { buildGeminiEnvHookOutput } from "../gemini/env-hook.ts";
import {
  getInstallation,
  type InstallationArtifact,
  removeInstallation,
  writeInstallation,
} from "../harness/installations.ts";
import {
  type JsonHookEntry,
  upsertJsonHooksFile,
} from "../harness-hooks-json.ts";
import { logUnrecognizedPayloadShape } from "../harness-shape-log.ts";
import { removeHarnessFromProfiles } from "../local-config.ts";
import { buildMeCommand, installMcpServer, MCP_TOOLS } from "../mcp/install.ts";

const GEMINI_ENV_HOOK_COMMAND = "me gemini env-hook";
const GEMINI_HOOK_ENTRY: JsonHookEntry = {
  matcher: "run_shell_command",
  hooks: [{ type: "command", command: GEMINI_ENV_HOOK_COMMAND }],
};

export function geminiSettingsPath(): string {
  return join(homedir(), ".gemini", "settings.json");
}

function hasGeminiHook(path: string): boolean {
  if (!existsSync(path)) return false;
  const root: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!root || typeof root !== "object" || Array.isArray(root)) return false;
  const hooks = (root as { hooks?: unknown }).hooks;
  const entries =
    hooks && typeof hooks === "object" && !Array.isArray(hooks)
      ? (hooks as { BeforeTool?: unknown }).BeforeTool
      : undefined;
  return (
    Array.isArray(entries) &&
    entries.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        Array.isArray((entry as { hooks?: unknown }).hooks) &&
        (entry as { hooks: Array<{ command?: unknown }> }).hooks.some(
          (hook) => hook?.command === GEMINI_ENV_HOOK_COMMAND,
        ),
    )
  );
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

function geminiMcpTool() {
  const tool = MCP_TOOLS.find((candidate) => candidate.bin === "gemini");
  if (!tool || tool.method !== "cli") {
    throw new Error("Gemini CLI MCP installer is unavailable.");
  }
  return tool;
}

async function installGemini(): Promise<void> {
  const previous = getInstallation("gemini");
  const settingsPath = geminiSettingsPath();
  const hookArtifact: InstallationArtifact = {
    kind: "json-hook",
    path: settingsPath,
    event: "BeforeTool",
    command: GEMINI_ENV_HOOK_COMMAND,
  };
  const hookWasRecorded = previous?.artifacts.some(
    (artifact) =>
      artifact.kind === "json-hook" &&
      artifact.path === settingsPath &&
      artifact.event === hookArtifact.event &&
      artifact.command === hookArtifact.command,
  );
  const hookAlreadyExists = hasGeminiHook(settingsPath);
  const result = await installMcpServer(geminiMcpTool(), buildMeCommand({}), {
    scope: "user",
    replaceExisting: false,
  });
  if (!result.success) throw new Error(result.message);

  if (!hookAlreadyExists || hookWasRecorded) installGeminiEnvHook(settingsPath);

  const artifacts: InstallationArtifact[] = [];
  if (
    !result.preserved ||
    previous?.artifacts.some((artifact) => artifact.kind === "mcp-cli")
  ) {
    artifacts.push({ kind: "mcp-cli", server_name: "me", scope: "user" });
  }
  if (!hookAlreadyExists || hookWasRecorded) artifacts.push(hookArtifact);
  if (artifacts.length > 0) {
    writeInstallation("gemini", {
      installed_at: new Date().toISOString(),
      me_version: CLIENT_VERSION,
      artifacts,
    });
  }
  console.log(result.message);
}

async function uninstallGemini(purge: boolean): Promise<void> {
  const installation = getInstallation("gemini");
  if (!installation) return;
  const retained: InstallationArtifact[] = [];
  for (const artifact of installation.artifacts) {
    if (artifact.kind === "mcp-cli") {
      if (artifact.scope !== "user") {
        retained.push(artifact);
        continue;
      }
      const process = Bun.spawn(geminiMcpTool().removeCmd({ scope: "user" }), {
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await process.exited) !== 0) retained.push(artifact);
    } else if (artifact.kind === "json-hook") {
      try {
        uninstallGeminiEnvHook(artifact.path);
      } catch {
        retained.push(artifact);
      }
    } else {
      retained.push(artifact);
    }
  }
  if (retained.length > 0) {
    throw new Error(
      "Gemini integration cleanup was incomplete; retained recorded artifacts.",
    );
  }
  removeInstallation("gemini");
  if (purge) removeHarnessFromProfiles("gemini");
}

function createGeminiEnvHookCommand(): Command {
  return new Command("env-hook")
    .description("inject the Gemini shell contract")
    .action(async () => {
      let payload: unknown;
      try {
        payload = JSON.parse(await Bun.stdin.text());
      } catch {
        logUnrecognizedPayloadShape("gemini", undefined);
        return;
      }
      const result = buildGeminiEnvHookOutput(payload, process.env);
      if (result.unrecognizedShape) {
        logUnrecognizedPayloadShape("gemini", payload);
      }
      if (result.output) console.log(JSON.stringify(result.output));
    });
}

export function createGeminiCommand(): Command {
  const gemini = new Command("gemini").description("Gemini CLI integration");
  gemini
    .addCommand(
      new Command("install")
        .description("install Memory Engine's dormant Gemini CLI integration")
        .action(installGemini),
    )
    .addCommand(
      new Command("uninstall")
        .description("uninstall the recorded Gemini CLI integration")
        .option("--purge", "remove Gemini from local activation profiles")
        .action((opts: { purge?: boolean }) =>
          uninstallGemini(opts.purge === true),
        ),
    )
    .addCommand(createGeminiEnvHookCommand());
  return gemini;
}
