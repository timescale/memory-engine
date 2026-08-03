/** Provider-owned dormant Claude Code installation adapter. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type {
  HarnessInstallation,
  InstallationArtifact,
} from "../harness/installations.ts";

const MARKETPLACE_SOURCE = "timescale/memory-engine";
const MARKETPLACE_NAME = "memory-engine";
const PLUGIN_REF = "memory-engine@memory-engine";
const USER_SCOPE = "user";

export type ClaudeIntegrationMode = "plugin" | "mcp-only";

export interface ClaudeInstallResult {
  artifacts: InstallationArtifact[];
  messages: string[];
}

export interface ClaudeUninstallResult {
  removed: InstallationArtifact[];
  retained: InstallationArtifact[];
  messages: string[];
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ClaudeIntegrationDependencies {
  hasClaude: () => boolean;
  run: (command: string[]) => Promise<CommandResult>;
}

const defaultDependencies: ClaudeIntegrationDependencies = {
  hasClaude: () => Bun.which("claude") !== null,
  async run(command) {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  },
};

function alreadyExists(result: CommandResult): boolean {
  return /already (?:exists|installed|added)|duplicate/i.test(
    `${result.stdout}\n${result.stderr}`,
  );
}

function assertClaudeAvailable(
  dependencies: ClaudeIntegrationDependencies,
): void {
  if (!dependencies.hasClaude()) {
    throw new Error("Claude Code (claude) was not found on PATH.");
  }
}

async function addMarketplace(
  dependencies: ClaudeIntegrationDependencies,
): Promise<{ added: boolean; message?: string }> {
  const result = await dependencies.run([
    "claude",
    "plugin",
    "marketplace",
    "add",
    "--scope",
    USER_SCOPE,
    MARKETPLACE_SOURCE,
  ]);
  if (result.exitCode === 0) {
    return {
      added: true,
      message: "Added the Memory Engine Claude marketplace.",
    };
  }
  if (alreadyExists(result)) return { added: false };
  throw new Error(
    `Claude marketplace registration failed: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`}`,
  );
}

async function removeMarketplace(
  dependencies: ClaudeIntegrationDependencies,
): Promise<void> {
  const result = await dependencies.run([
    "claude",
    "plugin",
    "marketplace",
    "remove",
    MARKETPLACE_NAME,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `exit code ${result.exitCode}`,
    );
  }
}

async function installPlugin(
  dependencies: ClaudeIntegrationDependencies,
): Promise<ClaudeInstallResult> {
  const marketplace = await addMarketplace(dependencies);
  const messages = marketplace.message ? [marketplace.message] : [];
  const result = await dependencies.run([
    "claude",
    "plugin",
    "install",
    "--scope",
    USER_SCOPE,
    PLUGIN_REF,
  ]);
  if (result.exitCode === 0) {
    return {
      artifacts: [
        {
          kind: "plugin",
          marketplace: MARKETPLACE_NAME,
          plugin: PLUGIN_REF,
        },
      ],
      messages: [...messages, "Installed the dormant Memory Engine plugin."],
    };
  }
  if (alreadyExists(result)) {
    return {
      artifacts: [],
      messages: [
        ...messages,
        "Claude already has an unrecorded Memory Engine plugin; leaving it unchanged.",
      ],
    };
  }
  const failure =
    result.stderr.trim() ||
    result.stdout.trim() ||
    `exit code ${result.exitCode}`;
  if (marketplace.added) {
    try {
      await removeMarketplace(dependencies);
    } catch (error) {
      throw new Error(
        `Claude plugin installation failed: ${failure}. The marketplace was added but could not be removed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(`Claude plugin installation failed: ${failure}`);
}

async function installMcpOnly(
  dependencies: ClaudeIntegrationDependencies,
): Promise<ClaudeInstallResult> {
  const result = await dependencies.run([
    "claude",
    "mcp",
    "add",
    "--scope",
    USER_SCOPE,
    "me",
    "--",
    "me",
    "mcp",
  ]);
  if (result.exitCode === 0) {
    return {
      artifacts: [{ kind: "mcp-cli", server_name: "me", scope: USER_SCOPE }],
      messages: ["Registered dormant Memory Engine MCP with Claude Code."],
    };
  }
  if (alreadyExists(result)) {
    return {
      artifacts: [],
      messages: [
        "Claude already has an unrecorded me MCP registration; leaving it unchanged.",
      ],
    };
  }
  throw new Error(
    `Claude MCP registration failed: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`}`,
  );
}

/** Install one dormant Claude integration mode without writing inventory. */
export async function installClaudeIntegration(
  mode: ClaudeIntegrationMode = "plugin",
  dependencies: ClaudeIntegrationDependencies = defaultDependencies,
): Promise<ClaudeInstallResult> {
  assertClaudeAvailable(dependencies);
  return mode === "plugin"
    ? installPlugin(dependencies)
    : installMcpOnly(dependencies);
}

function removeRecordedFile(
  artifact: Extract<InstallationArtifact, { kind: "file" }>,
): ClaudeUninstallResult {
  try {
    if (!existsSync(artifact.path)) {
      return { removed: [artifact], retained: [], messages: [] };
    }
    const sha256 = createHash("sha256")
      .update(readFileSync(artifact.path))
      .digest("hex");
    if (sha256 !== artifact.sha256) {
      return {
        removed: [],
        retained: [artifact],
        messages: [`Retained modified file: ${artifact.path}`],
      };
    }
    unlinkSync(artifact.path);
    return { removed: [artifact], retained: [], messages: [] };
  } catch (error) {
    return {
      removed: [],
      retained: [artifact],
      messages: [
        `Retained ${artifact.path}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

/** Remove only artifacts in a recorded Claude installation. */
export async function uninstallClaudeIntegration(
  record: HarnessInstallation,
  dependencies: ClaudeIntegrationDependencies = defaultDependencies,
): Promise<ClaudeUninstallResult> {
  const removed: InstallationArtifact[] = [];
  const retained: InstallationArtifact[] = [];
  const messages: string[] = [];

  for (const artifact of record.artifacts) {
    if (artifact.kind === "file") {
      const result = removeRecordedFile(artifact);
      removed.push(...result.removed);
      retained.push(...result.retained);
      messages.push(...result.messages);
      continue;
    }
    if (artifact.kind !== "plugin" && artifact.kind !== "mcp-cli") {
      retained.push(artifact);
      messages.push(`Retained unsupported Claude artifact: ${artifact.kind}.`);
      continue;
    }
    const command =
      artifact.kind === "plugin"
        ? [
            "claude",
            "plugin",
            "uninstall",
            "-y",
            "--scope",
            USER_SCOPE,
            artifact.plugin,
          ]
        : [
            "claude",
            "mcp",
            "remove",
            "--scope",
            artifact.scope ?? USER_SCOPE,
            artifact.server_name,
          ];
    try {
      const result = await dependencies.run(command);
      if (result.exitCode === 0) {
        removed.push(artifact);
        messages.push(`Removed Claude ${artifact.kind} artifact.`);
      } else {
        retained.push(artifact);
        messages.push(
          `Retained Claude ${artifact.kind} artifact: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`}`,
        );
      }
    } catch (error) {
      retained.push(artifact);
      messages.push(
        `Retained Claude ${artifact.kind} artifact: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { removed, retained, messages };
}
