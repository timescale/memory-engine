/** Canonical harness registry and installation facade. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { InvalidArgumentError } from "commander";
import { CLIENT_VERSION } from "../../../version";
import {
  buildMeCommand,
  installMcpServer,
  MCP_TOOLS,
  openCodeConfigPath,
} from "../mcp/install.ts";
import {
  getInstallation,
  type HarnessInstallation,
  type InstallationArtifact,
  removeInstallation,
  writeInstallation,
} from "./installations.ts";

export const HARNESS_NAMES = ["claude", "opencode", "codex", "gemini"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

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
  });
  if (!result.success) throw new Error(result.message);
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
  const entry = value as { command?: unknown };
  return (
    Array.isArray(entry.command) &&
    entry.command.length === 2 &&
    entry.command[0] === "me" &&
    entry.command[1] === "mcp"
  );
}

function uninstallJsonArtifact(
  artifact: Extract<InstallationArtifact, { kind: "mcp-json" }>,
): HarnessUninstallResult {
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
    writeFileSync(
      artifact.path,
      `${JSON.stringify({ ...config, mcp: remaining }, null, 2)}\n`,
    );
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
      const result = uninstallJsonArtifact(artifact);
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

export async function installHarness(name: HarnessName): Promise<void> {
  const result = await getHarness(name).install();
  writeInstallation(name, {
    installed_at: new Date().toISOString(),
    me_version: CLIENT_VERSION,
    artifacts: result.artifacts,
  });
  for (const message of result.messages) console.log(message);
}

export async function uninstallHarness(name: HarnessName): Promise<void> {
  const record = getInstallation(name);
  if (!record) return;
  const result = await getHarness(name).uninstall(record);
  if (result.retained.length === 0) removeInstallation(name);
  for (const message of result.messages) console.log(message);
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
