/** OpenCode integration commands. */
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Command } from "commander";
import type { StepAvailability } from "../agent/init.ts";
import { createMemoryClient } from "../client.ts";
import { resolveCredentials } from "../credentials.ts";
import {
  fileMatchesArtifact,
  getInstallation,
  type HarnessInstallation,
  type InstallationArtifact,
  removeInstallation,
} from "../harness/installations.ts";
import {
  type HarnessDescriptor,
  type HarnessInstallResult,
  type HarnessUninstallResult,
  installHarness,
} from "../harness/registry.ts";
import { importTranscriptSession } from "../importers/index.ts";
import { parseSessionById } from "../importers/opencode.ts";
import {
  removeHarnessFromProfiles,
  resolveCaptureProfile,
} from "../local-config.ts";
import {
  buildMeCommand,
  installMcpServer,
  MCP_TOOLS,
  openCodeConfigPath,
  writeOpenCodeConfigAtomically,
} from "../mcp/install.ts";
import {
  HOOK_EVENT_NAMES,
  type HookEventName,
  resolveHookConfig,
  SESSIONS_NODE,
} from "../opencode/capture.ts";
import {
  PLUGIN_FILENAME,
  renderPluginSource,
} from "../opencode/plugin-template.ts";
import { openCodePluginsDir } from "../opencode/scope.ts";
import { memoryBearer } from "../session.ts";
import { createOpenCodeImportCommand } from "./import.ts";

const openCodePluginPath = (): string =>
  join(openCodePluginsDir(), PLUGIN_FILENAME);

function fileArtifact(path: string, contents: string): InstallationArtifact {
  return {
    kind: "file",
    path: resolve(path),
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

async function writePlugin(): Promise<InstallationArtifact> {
  const path = openCodePluginPath();
  const contents = renderPluginSource();
  await mkdir(openCodePluginsDir(), { recursive: true });
  await writeFile(path, contents);
  return fileArtifact(path, contents);
}

function dormantMcpEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
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

async function uninstallMcpJson(
  artifact: Extract<InstallationArtifact, { kind: "mcp-json" }>,
): Promise<HarnessUninstallResult> {
  try {
    const config = JSON.parse(await readFile(artifact.path, "utf8")) as Record<
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
        removed: [artifact],
        retained: [],
        messages: ["OpenCode MCP entry is already absent."],
      };
    }
    const entries = mcp as Record<string, unknown>;
    if (!dormantMcpEntry(entries.me)) {
      return {
        removed: [],
        retained: [artifact],
        messages: [`Retained ${artifact.path}: its me entry has changed.`],
      };
    }
    const { me: _, ...remaining } = entries;
    const next = { ...config };
    if (Object.keys(remaining).length === 0) delete next.mcp;
    else next.mcp = remaining;
    await writeOpenCodeConfigAtomically(artifact.path, next);
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

/** Remove only artifacts recorded for the OpenCode integration. */
export async function uninstallOpenCodeArtifacts(
  record: HarnessInstallation,
): Promise<HarnessUninstallResult> {
  const removed: InstallationArtifact[] = [];
  const retained: InstallationArtifact[] = [];
  const messages: string[] = [];
  for (const artifact of record.artifacts) {
    if (artifact.kind === "mcp-json") {
      const result = await uninstallMcpJson(artifact);
      removed.push(...result.removed);
      retained.push(...result.retained);
      messages.push(...result.messages);
    } else if (artifact.kind === "file") {
      if (!fileMatchesArtifact(artifact)) {
        retained.push(artifact);
        messages.push(
          `Retained ${artifact.path}: the generated file has changed.`,
        );
        continue;
      }
      try {
        await unlink(artifact.path);
        removed.push(artifact);
        messages.push(`Removed ${artifact.path}.`);
      } catch (error) {
        retained.push(artifact);
        messages.push(
          `Retained ${artifact.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      retained.push(artifact);
      messages.push(
        `Retained incompatible OpenCode artifact: ${artifact.kind}.`,
      );
    }
  }
  return { removed, retained, messages };
}

async function installOpenCodeArtifacts(): Promise<HarnessInstallResult> {
  const tool = MCP_TOOLS.find((candidate) => candidate.bin === "opencode");
  if (!tool || tool.method !== "json-file")
    throw new Error("OpenCode MCP installer is unavailable.");
  const result = await installMcpServer(tool, buildMeCommand({}), {
    scope: "user",
    replaceExisting: false,
  });
  if (!result.success) throw new Error(result.message);

  const artifacts: InstallationArtifact[] = [await writePlugin()];
  if (!result.preserved) {
    artifacts.unshift({
      kind: "mcp-json",
      path: resolve(openCodeConfigPath({ scope: "user" })),
      server_name: "me",
    });
  } else {
    const recorded = getInstallation("opencode");
    const mcp = recorded?.artifacts.find(
      (
        artifact,
      ): artifact is Extract<InstallationArtifact, { kind: "mcp-json" }> =>
        artifact.kind === "mcp-json",
    );
    if (mcp) artifacts.unshift(mcp);
  }
  return {
    artifacts,
    messages: [
      result.message,
      `Installed OpenCode dormant plugin → ${openCodePluginPath()}`,
    ],
  };
}

const openCodeDescriptor: HarnessDescriptor = {
  name: "opencode",
  displayName: "OpenCode",
  binary: "opencode",
  detect: () => Bun.which("opencode") !== null,
  install: installOpenCodeArtifacts,
  uninstall: uninstallOpenCodeArtifacts,
};

/** Compatibility entry point for the retiring project-init preflight. */
export async function runOpenCodeInstallFlow(
  ..._args: unknown[]
): Promise<void> {
  await installHarness("opencode", { harness: openCodeDescriptor });
}

/** Project init must not offer the retired OpenCode setup flow. */
export async function openCodeSetupAvailable(): Promise<StepAvailability> {
  return "hidden";
}

function createOpenCodeInstallCommand(): Command {
  return new Command("install")
    .description(
      "install Memory Engine's dormant user-global OpenCode integration",
    )
    .action(runOpenCodeInstallFlow);
}

function createOpenCodeUninstallCommand(): Command {
  return new Command("uninstall")
    .description("uninstall the recorded Memory Engine OpenCode integration")
    .option("--purge", "remove OpenCode from local activation profiles")
    .action(async (opts: { purge?: boolean }) => {
      const record = getInstallation("opencode");
      if (!record) return;
      const result = await uninstallOpenCodeArtifacts(record);
      for (const message of result.messages) console.log(message);
      if (result.retained.length === 0) {
        removeInstallation("opencode");
        if (opts.purge) removeHarnessFromProfiles("opencode");
      }
    });
}

function createOpenCodeHookCommand(): Command {
  return new Command("hook")
    .description("invoked by the OpenCode plugin to capture a session")
    .requiredOption(
      "--event <name>",
      `hook event name (${HOOK_EVENT_NAMES.join(", ")})`,
    )
    .requiredOption("--session <id>", "OpenCode session id (e.g. ses_abc123)")
    .requiredOption("--project-dir <dir>", "OpenCode session directory")
    .option(
      "--storage <dir>",
      "OpenCode data dir, SQLite DB, or legacy storage dir",
    )
    .action(
      async (opts: {
        event: string;
        session: string;
        projectDir: string;
        storage?: string;
      }) => {
        const eventName = opts.event as HookEventName;
        if (!HOOK_EVENT_NAMES.includes(eventName)) return;
        const profile = resolveCaptureProfile(opts.projectDir);
        if (
          profile.source === "disabled" ||
          !profile.value?.enabled ||
          profile.value.harnesses.opencode !== true
        )
          return;
        const config = resolveHookConfig(
          // The selected capture profile owns targeting. The explicit server
          // keeps legacy project config from contributing one here.
          resolveCredentials(profile.value.server),
          profile.value,
        );
        if (!config) return;
        try {
          const session = await parseSessionById(opts.session, opts.storage);
          if (!session) return;
          const client = createMemoryClient({
            url: config.server,
            ...memoryBearer(config.server, config.apiKey),
            space: config.space,
          });
          await importTranscriptSession(client, session, {
            treeRoot: config.treeRoot,
            tree: config.tree,
            sessionsNodeName: SESSIONS_NODE,
            fullTranscript: false,
            dryRun: false,
            verbose: false,
          });
        } catch (error) {
          console.error(
            `[memory-engine] ${eventName} capture failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );
}

export function createOpenCodeCommand(): Command {
  const opencode = new Command("opencode").description("OpenCode integration");
  opencode.addCommand(createOpenCodeInstallCommand());
  opencode.addCommand(createOpenCodeUninstallCommand());
  opencode.addCommand(createOpenCodeHookCommand());
  opencode.addCommand(createOpenCodeImportCommand());
  return opencode;
}
