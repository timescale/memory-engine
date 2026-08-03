/** Canonical harness registry and installation facade. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InvalidArgumentError } from "commander";
import { CLIENT_VERSION } from "../../../version";
import {
  buildMeCommand,
  installMcpServer,
  MCP_TOOLS,
  openCodeConfigPath,
  writeOpenCodeConfigAtomically,
} from "../mcp/install.ts";
import {
  getInstallation,
  type HarnessInstallation,
  type InstallationArtifact,
  removeInstallation,
  writeInstallation,
} from "./installations.ts";
import { HARNESS_NAMES, type HarnessName } from "./names.ts";

export { HARNESS_NAMES, type HarnessName } from "./names.ts";

export interface HarnessInstallResult {
  artifacts: InstallationArtifact[];
  messages: string[];
}

export interface HarnessUninstallResult {
  removed: InstallationArtifact[];
  retained: InstallationArtifact[];
  messages: string[];
}

export interface HarnessDescriptor {
  name: HarnessName;
  displayName: string;
  binary: string;
  detect(): boolean;
  install(): Promise<HarnessInstallResult>;
  uninstall(record: HarnessInstallation): Promise<HarnessUninstallResult>;
}

export function parseHarnessName(value: string): HarnessName {
  if ((HARNESS_NAMES as readonly string[]).includes(value))
    return value as HarnessName;
  throw new InvalidArgumentError(
    `unknown harness '${value}'; expected one of: ${HARNESS_NAMES.join(", ")}`,
  );
}

function toolFor(name: HarnessName) {
  const binary = name === "claude" ? "claude" : name;
  const tool = MCP_TOOLS.find((candidate) => candidate.bin === binary);
  if (!tool) throw new Error(`No MCP installer is registered for ${name}.`);
  return tool;
}

async function installMcp(name: HarnessName): Promise<HarnessInstallResult> {
  const tool = toolFor(name);
  const result = await installMcpServer(tool, buildMeCommand({}), {
    scope: "user",
    replaceExisting: getInstallation(name) !== undefined,
  });
  if (!result.success) throw new Error(result.message);
  if (result.preserved) {
    return { artifacts: [], messages: [result.message] };
  }
  const artifact: InstallationArtifact =
    tool.method === "cli"
      ? { kind: "mcp-cli", server_name: "me", scope: "user" }
      : {
          kind: "mcp-json",
          path: resolve(openCodeConfigPath({ scope: "user" })),
          server_name: "me",
        };
  return { artifacts: [artifact], messages: [result.message] };
}

function isDormantMcpEntry(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    Object.keys(entry).length === 2 &&
    entry.type === "local" &&
    Array.isArray(entry.command) &&
    entry.command.length === 2 &&
    entry.command[0] === "me" &&
    entry.command[1] === "mcp"
  );
}

async function uninstallJsonArtifact(
  artifact: Extract<InstallationArtifact, { kind: "mcp-json" }>,
): Promise<HarnessUninstallResult> {
  try {
    const config = JSON.parse(readFileSync(artifact.path, "utf8")) as Record<
      string,
      unknown
    >;
    const mcp = config.mcp;
    if (
      !mcp ||
      typeof mcp !== "object" ||
      Array.isArray(mcp) ||
      !("me" in mcp)
    ) {
      return {
        removed: [],
        retained: [],
        messages: ["OpenCode MCP entry is already absent."],
      };
    }
    const entries = mcp as Record<string, unknown>;
    if (!isDormantMcpEntry(entries.me)) {
      return {
        removed: [],
        retained: [artifact],
        messages: [`Retained ${artifact.path}: its me entry has changed.`],
      };
    }
    const { me: _, ...remaining } = entries;
    await writeOpenCodeConfigAtomically(artifact.path, {
      ...config,
      mcp: remaining,
    });
    return {
      removed: [artifact],
      retained: [],
      messages: ["Removed OpenCode MCP entry."],
    };
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

async function uninstallMcp(
  name: HarnessName,
  record: HarnessInstallation,
): Promise<HarnessUninstallResult> {
  const removed: InstallationArtifact[] = [];
  const retained: InstallationArtifact[] = [];
  const messages: string[] = [];
  for (const artifact of record.artifacts) {
    if (artifact.kind === "mcp-cli") {
      const tool = toolFor(name);
      if (tool.method !== "cli") {
        retained.push(artifact);
        messages.push(
          `Retained incompatible recorded MCP artifact for ${name}.`,
        );
        continue;
      }
      const process = Bun.spawn(tool.removeCmd({ scope: artifact.scope }), {
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await process.exited) === 0) {
        removed.push(artifact);
        messages.push(`Removed MCP registration for ${name}.`);
      } else {
        retained.push(artifact);
        messages.push(
          `Retained MCP registration for ${name}: provider removal failed.`,
        );
      }
    } else if (artifact.kind === "mcp-json") {
      const result = await uninstallJsonArtifact(artifact);
      removed.push(...result.removed);
      retained.push(...result.retained);
      messages.push(...result.messages);
    } else {
      retained.push(artifact);
      messages.push(
        `Retained ${artifact.kind}: Wave 2 provider adapter cleanup is required.`,
      );
    }
  }
  return { removed, retained, messages };
}

function descriptor(
  name: HarnessName,
  displayName: string,
  binary: string,
): HarnessDescriptor {
  return {
    name,
    displayName,
    binary,
    detect: () => Bun.which(binary) !== null,
    install: () => installMcp(name),
    uninstall: (record) => uninstallMcp(name, record),
  };
}

const HARNESS_REGISTRY: Record<HarnessName, HarnessDescriptor> = {
  claude: descriptor("claude", "Claude Code", "claude"),
  opencode: descriptor("opencode", "OpenCode", "opencode"),
  codex: descriptor("codex", "Codex CLI", "codex"),
  gemini: descriptor("gemini", "Gemini CLI", "gemini"),
};

export function getHarness(name: HarnessName): HarnessDescriptor {
  return HARNESS_REGISTRY[name];
}

export function detectInstalledHarnesses(): HarnessDescriptor[] {
  return HARNESS_NAMES.map(getHarness).filter((harness) => harness.detect());
}

export function isHarnessInstalled(name: HarnessName): boolean {
  return getInstallation(name) !== undefined;
}

export async function installHarness(
  name: HarnessName,
  operations: {
    harness?: HarnessDescriptor;
    writeInstallation?: (
      target: HarnessName,
      record: HarnessInstallation,
    ) => void;
  } = {},
): Promise<void> {
  const harness = operations.harness ?? getHarness(name);
  const result = await harness.install();
  if (result.artifacts.length > 0) {
    const record = {
      installed_at: new Date().toISOString(),
      me_version: CLIENT_VERSION,
      artifacts: result.artifacts,
    };
    try {
      (operations.writeInstallation ?? writeInstallation)(name, record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        const rollback = await harness.uninstall(record);
        if (rollback.retained.length === 0) {
          throw new Error(
            `Installed ${name}, but could not record it in the installation inventory: ${message}. The registration was rolled back.`,
          );
        }
        const retainedArtifact = rollback.retained[0] ?? result.artifacts[0];
        const cleanup = retainedArtifact
          ? manualCleanupCommand(name, retainedArtifact)
          : `me uninstall ${name}`;
        throw new Error(
          `Installed ${name}, but could not record it in the installation inventory: ${message}. Automatic rollback retained ${rollback.retained.map(describeArtifact).join(", ")}. Remove it manually with: ${cleanup}`,
        );
      } catch (rollbackError) {
        if (
          rollbackError instanceof Error &&
          rollbackError.message.startsWith(
            `Installed ${name}, but could not record`,
          )
        ) {
          throw rollbackError;
        }
        const rollbackMessage =
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError);
        const artifact = result.artifacts[0];
        const cleanup = artifact
          ? manualCleanupCommand(name, artifact)
          : `me uninstall ${name}`;
        throw new Error(
          `Installed ${name}, but could not record it in the installation inventory: ${message}. Automatic rollback failed: ${rollbackMessage}. Remove it manually with: ${cleanup}`,
        );
      }
    }
  }
  for (const message of result.messages) console.log(message);
}

function describeArtifact(artifact: InstallationArtifact): string {
  return artifact.kind === "mcp-json"
    ? artifact.path
    : `${artifact.kind} registration`;
}

function manualCleanupCommand(
  name: HarnessName,
  artifact: InstallationArtifact,
): string {
  if (artifact.kind === "mcp-json")
    return `remove mcp.me from ${artifact.path}`;
  if (artifact.kind === "mcp-cli") {
    const tool = toolFor(name);
    if (tool.method === "cli")
      return tool.removeCmd({ scope: artifact.scope }).join(" ");
  }
  return `remove the ${artifact.kind} artifact`;
}

export async function uninstallHarness(name: HarnessName): Promise<boolean> {
  const record = getInstallation(name);
  if (!record) return true;
  const result = await getHarness(name).uninstall(record);
  if (result.retained.length === 0) removeInstallation(name);
  for (const message of result.messages) console.log(message);
  return result.retained.length === 0;
}

export function resolveHarnessTargets(
  values: string[],
  install: boolean,
  detected: () => HarnessDescriptor[] = detectInstalledHarnesses,
  installed: (name: HarnessName) => boolean = isHarnessInstalled,
): HarnessName[] {
  if (values.length > 0) return values.map(parseHarnessName);
  return install
    ? detected().map((harness) => harness.name)
    : HARNESS_NAMES.filter(installed);
}
