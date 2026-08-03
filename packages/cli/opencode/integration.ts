/** User-global dormant OpenCode integration adapter. */
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  HarnessInstallation,
  InstallationArtifact,
} from "../harness/installations.ts";
import { writeOpenCodeConfigAtomically } from "../mcp/install.ts";
import {
  PLUGIN_FILENAME,
  PLUGIN_MARKER,
  renderPluginSource,
} from "./plugin-template.ts";

export interface OpenCodeIntegrationResult {
  artifacts: InstallationArtifact[];
  messages: string[];
}

export interface OpenCodeIntegrationPaths {
  configPath: string;
  pluginPath: string;
}

export function getOpenCodeIntegrationPaths(): OpenCodeIntegrationPaths {
  const base = join(homedir(), ".config", "opencode");
  return {
    configPath: join(base, "opencode.json"),
    pluginPath: join(base, "plugins", PLUGIN_FILENAME),
  };
}

function hash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
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

async function readConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${path} is not a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/** Install only the global MCP entry and generated dormant plugin. */
export async function installOpenCodeIntegration(
  paths: OpenCodeIntegrationPaths = getOpenCodeIntegrationPaths(),
  existing?: HarnessInstallation,
): Promise<OpenCodeIntegrationResult> {
  const priorPlugin = existing?.artifacts.find(
    (artifact) =>
      artifact.kind === "file" && artifact.path === resolve(paths.pluginPath),
  );
  const plugin = renderPluginSource();
  try {
    const existingPlugin = await readFile(paths.pluginPath, "utf8");
    if (!existingPlugin.startsWith(PLUGIN_MARKER)) {
      throw new Error(`OpenCode plugin at ${paths.pluginPath} is user-owned.`);
    }
    if (!priorPlugin) {
      throw new Error(
        `OpenCode plugin at ${paths.pluginPath} is unrecorded; leaving it unchanged.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const config = await readConfig(paths.configPath);
  const mcp = config.mcp;
  if (
    mcp !== undefined &&
    (!mcp || typeof mcp !== "object" || Array.isArray(mcp))
  ) {
    throw new Error(`OpenCode mcp config in ${paths.configPath} is malformed.`);
  }
  const entries = { ...((mcp as Record<string, unknown> | undefined) ?? {}) };
  const existingEntry = entries.me;
  const artifacts: InstallationArtifact[] = [];
  let createdMcp = false;
  if (!existingEntry) {
    entries.me = { type: "local", command: ["me", "mcp"] };
    await writeOpenCodeConfigAtomically(paths.configPath, {
      ...config,
      mcp: entries,
    });
    artifacts.push({
      kind: "mcp-json",
      path: resolve(paths.configPath),
      server_name: "me",
    });
    createdMcp = true;
  } else if (!dormantMcpEntry(existingEntry)) {
    throw new Error(`OpenCode MCP entry in ${paths.configPath} is user-owned.`);
  } else {
    const priorMcp = existing?.artifacts.find(
      (artifact) =>
        artifact.kind === "mcp-json" &&
        artifact.path === resolve(paths.configPath),
    );
    if (!priorMcp) {
      throw new Error(
        `OpenCode MCP entry in ${paths.configPath} is unrecorded; refusing to claim ownership.`,
      );
    }
    artifacts.push(priorMcp);
  }

  try {
    await mkdir(dirname(paths.pluginPath), { recursive: true });
    await writeFile(paths.pluginPath, plugin);
    artifacts.push({
      kind: "file",
      path: resolve(paths.pluginPath),
      sha256: hash(plugin),
    });
  } catch (error) {
    if (createdMcp) await uninstallOpenCodeIntegration(artifacts);
    throw error;
  }
  return {
    artifacts,
    messages: [
      ...(createdMcp ? ["Registered OpenCode MCP entry."] : []),
      `Installed OpenCode dormant plugin → ${paths.pluginPath}`,
    ],
  };
}

/** Remove exactly the artifacts supplied by the installation record. */
export async function uninstallOpenCodeIntegration(
  artifacts: InstallationArtifact[],
): Promise<{
  removed: InstallationArtifact[];
  retained: InstallationArtifact[];
  messages: string[];
}> {
  const removed: InstallationArtifact[] = [];
  const retained: InstallationArtifact[] = [];
  const messages: string[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind === "mcp-json") {
      try {
        const config = await readConfig(artifact.path);
        const mcp = config.mcp;
        if (
          !mcp ||
          typeof mcp !== "object" ||
          Array.isArray(mcp) ||
          !("me" in mcp)
        ) {
          removed.push(artifact);
          continue;
        }
        const entries = mcp as Record<string, unknown>;
        if (!dormantMcpEntry(entries.me)) {
          retained.push(artifact);
          messages.push(`Retained ${artifact.path}: its me entry has changed.`);
          continue;
        }
        const { me: _, ...remaining } = entries;
        const next = { ...config };
        if (Object.keys(remaining).length === 0) delete next.mcp;
        else next.mcp = remaining;
        await writeOpenCodeConfigAtomically(artifact.path, next);
        removed.push(artifact);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          removed.push(artifact);
          continue;
        }
        retained.push(artifact);
        messages.push(
          `Retained ${artifact.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (artifact.kind === "file") {
      try {
        const contents = await readFile(artifact.path, "utf8");
        if (hash(contents) !== artifact.sha256) {
          retained.push(artifact);
          messages.push(
            `Retained ${artifact.path}: the generated file has changed.`,
          );
          continue;
        }
        await unlink(artifact.path);
        removed.push(artifact);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          removed.push(artifact);
          continue;
        }
        retained.push(artifact);
        messages.push(
          `Retained ${artifact.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return { removed, retained, messages };
}
