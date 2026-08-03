/** Native, user-global Codex CLI integration plumbing. */
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

export const CODEX_ENV_HOOK_COMMAND = "me codex env-hook";

export const CODEX_HOOK_ENTRY: JsonHookEntry = {
  matcher: "^Bash$",
  hooks: [{ type: "command", command: CODEX_ENV_HOOK_COMMAND, timeout: 10 }],
};

export function codexHooksPath(): string {
  return join(homedir(), ".codex", "hooks.json");
}

export function installCodexEnvHook(
  path = codexHooksPath(),
): Extract<InstallationArtifact, { kind: "json-hook" }> {
  return installCodexEnvHookResult(path).artifact;
}

function installCodexEnvHookResult(path = codexHooksPath()): {
  artifact: Extract<InstallationArtifact, { kind: "json-hook" }>;
  changed: boolean;
} {
  const result = upsertJsonHooksFile(
    path,
    "PreToolUse",
    CODEX_HOOK_ENTRY,
    CODEX_ENV_HOOK_COMMAND,
  );
  return {
    artifact: {
      kind: "json-hook",
      path,
      event: "PreToolUse",
      command: CODEX_ENV_HOOK_COMMAND,
    },
    changed: result.changed,
  };
}

function isMatchingHookEntry(value: unknown, command: string): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { hooks?: unknown }).hooks) &&
    (value as { hooks: Array<{ command?: unknown }> }).hooks.some(
      (hook) => hook?.command === command,
    )
  );
}

/** Remove precisely the installed hook entry, retaining all other JSON data. */
export function removeCodexEnvHook(
  artifact: Extract<InstallationArtifact, { kind: "json-hook" }>,
): "removed" | "retained" {
  if (!existsSync(artifact.path)) return "removed";
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(artifact.path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return "retained";
    root = parsed as Record<string, unknown>;
  } catch {
    return "retained";
  }
  const hooks = root.hooks;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks))
    return "retained";
  const events = hooks as Record<string, unknown>;
  const entries = events[artifact.event];
  if (entries === undefined) return "removed";
  if (!Array.isArray(entries)) return "retained";
  const retained = entries.filter(
    (entry) => !isMatchingHookEntry(entry, artifact.command),
  );
  if (retained.length === entries.length) return "retained";
  writeFileSync(
    artifact.path,
    `${JSON.stringify(
      {
        ...root,
        hooks: { ...events, [artifact.event]: retained },
      },
      null,
      2,
    )}\n`,
  );
  return "removed";
}

function codexMcpTool() {
  const tool = MCP_TOOLS.find((candidate) => candidate.bin === "codex");
  if (!tool || tool.method !== "cli")
    throw new Error("Codex MCP installer is unavailable.");
  return tool;
}

/** The only Codex MCP registration command: `codex mcp add me -- me mcp`. */
export function codexMcpCommand(): string[] {
  return codexMcpTool().addCmd(buildMeCommand({}), {});
}

export interface CodexIntegrationResult {
  artifacts: InstallationArtifact[];
  messages: string[];
}

interface InstallOperations {
  installMcp?: () => Promise<InstallResult>;
  installHook?: () => {
    artifact: Extract<InstallationArtifact, { kind: "json-hook" }>;
    changed: boolean;
  };
}

export async function installCodexIntegration(
  existing?: HarnessInstallation,
  operations: InstallOperations = {},
): Promise<CodexIntegrationResult> {
  const registration = await (
    operations.installMcp ??
    (() =>
      installMcpServer(codexMcpTool(), buildMeCommand({}), {
        scope: "user",
        replaceExisting: false,
      }))
  )();
  if (!registration.success) throw new Error(registration.message);

  const hook = (operations.installHook ?? installCodexEnvHookResult)();
  const mcp = existing?.artifacts.find(
    (artifact) => artifact.kind === "mcp-cli",
  );
  return {
    artifacts: [
      ...(registration.preserved && !mcp
        ? []
        : [
            mcp ?? {
              kind: "mcp-cli" as const,
              server_name: "me" as const,
            },
          ]),
      ...(hook.changed
        ? [hook.artifact]
        : (existing?.artifacts.filter(
            (artifact) => artifact.kind === "json-hook",
          ) ?? [])),
    ],
    messages: [registration.message],
  };
}

export async function uninstallCodexIntegration(
  record: HarnessInstallation,
  operations: {
    removeMcp?: (
      artifact: Extract<InstallationArtifact, { kind: "mcp-cli" }>,
    ) => Promise<boolean>;
    removeHook?: (
      artifact: Extract<InstallationArtifact, { kind: "json-hook" }>,
    ) => "removed" | "retained";
  } = {},
): Promise<{
  removed: InstallationArtifact[];
  retained: InstallationArtifact[];
  messages: string[];
}> {
  const removed: InstallationArtifact[] = [];
  const retained: InstallationArtifact[] = [];
  const messages: string[] = [];
  for (const artifact of record.artifacts) {
    if (artifact.kind === "mcp-cli") {
      const removalSucceeded = await (
        operations.removeMcp ??
        (async (owned) => {
          const process = Bun.spawn(
            codexMcpTool().removeCmd({ scope: owned.scope }),
            { stdout: "pipe", stderr: "pipe" },
          );
          return (await process.exited) === 0;
        })
      )(artifact);
      if (!removalSucceeded) {
        retained.push(artifact);
        messages.push(
          "Retained Codex MCP registration: provider removal failed.",
        );
      } else {
        removed.push(artifact);
      }
    } else if (artifact.kind === "json-hook") {
      if (
        (operations.removeHook ?? removeCodexEnvHook)(artifact) === "retained"
      ) {
        retained.push(artifact);
        messages.push(
          `Retained ${artifact.path}: hook entry changed or configuration is invalid.`,
        );
      } else {
        removed.push(artifact);
      }
    } else {
      retained.push(artifact);
    }
  }
  return { removed, retained, messages };
}
