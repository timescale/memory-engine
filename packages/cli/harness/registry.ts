/** Canonical harness registry and installation facade. */
import { InvalidArgumentError } from "commander";
import { CLIENT_VERSION } from "../../../version";
import {
  installClaudeIntegration,
  uninstallClaudeIntegration,
} from "../claude/integration.ts";
import {
  installCodexIntegration,
  uninstallCodexIntegration,
} from "../codex/integration.ts";
import {
  installGeminiIntegration,
  uninstallGeminiIntegration,
} from "../gemini/integration.ts";
import {
  installOpenCodeIntegration,
  uninstallOpenCodeIntegration,
} from "../opencode/integration.ts";
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
  install(existing?: HarnessInstallation): Promise<HarnessInstallResult>;
  uninstall(record: HarnessInstallation): Promise<HarnessUninstallResult>;
}

export function parseHarnessName(value: string): HarnessName {
  if ((HARNESS_NAMES as readonly string[]).includes(value))
    return value as HarnessName;
  throw new InvalidArgumentError(
    `unknown harness '${value}'; expected one of: ${HARNESS_NAMES.join(", ")}`,
  );
}

function descriptor(
  name: HarnessName,
  displayName: string,
  binary: string,
  install: (existing?: HarnessInstallation) => Promise<HarnessInstallResult>,
  uninstall: (record: HarnessInstallation) => Promise<HarnessUninstallResult>,
): HarnessDescriptor {
  return {
    name,
    displayName,
    binary,
    detect: () => Bun.which(binary) !== null,
    install,
    uninstall,
  };
}

const HARNESS_REGISTRY: Record<HarnessName, HarnessDescriptor> = {
  claude: descriptor(
    "claude",
    "Claude Code",
    "claude",
    (existing) => installClaudeIntegration("plugin", undefined, existing),
    uninstallClaudeIntegration,
  ),
  opencode: descriptor(
    "opencode",
    "OpenCode",
    "opencode",
    (existing) => installOpenCodeIntegration(undefined, existing),
    (record) => uninstallOpenCodeIntegration(record.artifacts),
  ),
  codex: descriptor(
    "codex",
    "Codex CLI",
    "codex",
    installCodexIntegration,
    uninstallCodexIntegration,
  ),
  gemini: descriptor(
    "gemini",
    "Gemini CLI",
    "gemini",
    (existing) => installGeminiIntegration(undefined, undefined, existing),
    uninstallGeminiIntegration,
  ),
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
    getInstallation?: (target: HarnessName) => HarnessInstallation | undefined;
  } = {},
): Promise<void> {
  const harness = operations.harness ?? getHarness(name);
  const existing = (operations.getInstallation ?? getInstallation)(name);
  const result = await harness.install(existing);
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
      if (
        existing &&
        JSON.stringify(existing.artifacts) === JSON.stringify(record.artifacts)
      ) {
        throw new Error(
          `Could not update the installation inventory for ${name}: ${message}. The existing registration was left unchanged.`,
        );
      }
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
  if (artifact.kind === "mcp-cli")
    return `remove the me MCP registration from ${name}`;
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
