/**
 * Per-machine harness policy stored alongside human CLI state in config.yaml.
 * This module deliberately does not participate in normal human CLI resolution.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import { getGlobalConfigPath } from "./credentials.ts";

type HarnessName = "claude" | "opencode" | "codex" | "gemini";

const HARNESS_NAMES: readonly HarnessName[] = [
  "claude",
  "opencode",
  "codex",
  "gemini",
];
const PROFILE_KEYS = new Set(["mcp", "capture", "cli"]);
const MCP_KEYS = new Set(["enabled", "server", "space", "harnesses"]);
const CAPTURE_KEYS = new Set([
  "enabled",
  "server",
  "space",
  "tree",
  "tree_root",
  "harnesses",
]);
const CLI_KEYS = new Set(["server", "space", "harnesses"]);

export type HarnessSelection = Partial<Record<HarnessName, boolean>>;

export interface McpSurface {
  enabled: boolean;
  server?: string;
  space?: string;
  harnesses: HarnessSelection;
}

export interface CaptureSurface {
  enabled: boolean;
  server?: string;
  space?: string;
  tree?: string;
  tree_root?: string;
  harnesses: HarnessSelection;
}

export interface CliSurface {
  server?: string;
  space?: string;
  harnesses: HarnessSelection;
}

export interface HarnessProfile {
  mcp?: McpSurface;
  capture?: CaptureSurface;
  cli?: CliSurface;
}

export interface LocalConfig {
  version: 1;
  defaults?: HarnessProfile;
  directories: Record<string, HarnessProfile>;
}

export interface ResolvedSurface<T> {
  source: "directory" | "defaults" | "disabled";
  profile_path?: string;
  value?: T;
}

export interface ResolvedHarnessProfile {
  cwd: string;
  profile_source: "directory" | "defaults";
  profile_path?: string;
  mcp: ResolvedSurface<McpSurface>;
  capture: ResolvedSurface<CaptureSurface>;
}

type RawConfig = Record<string, unknown>;

function error(message: string): never {
  throw new Error(
    `Invalid local config in ${getGlobalConfigPath()}: ${message}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) error(`unknown ${path} key "${key}".`);
  }
}

function nonemptyString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    error(`${path} must be a non-empty string.`);
  }
  return value;
}

function parseHarnesses(value: unknown, path: string): HarnessSelection {
  if (!isRecord(value)) error(`${path} must be an object.`);
  const harnesses: HarnessSelection = {};
  for (const [name, selected] of Object.entries(value)) {
    if (!HARNESS_NAMES.includes(name as HarnessName)) {
      error(`${path} has unknown harness "${name}".`);
    }
    if (typeof selected !== "boolean")
      error(`${path}.${name} must be a boolean.`);
    harnesses[name as HarnessName] = selected;
  }
  return harnesses;
}

function hasSelectedHarnesses(harnesses: HarnessSelection): boolean {
  return HARNESS_NAMES.some((harness) => harnesses[harness] === true);
}

function parseMcp(value: unknown, path: string): McpSurface {
  if (!isRecord(value)) error(`${path} must be an object.`);
  assertKeys(value, MCP_KEYS, path);
  if (typeof value.enabled !== "boolean")
    error(`${path}.enabled must be a boolean.`);
  const surface: McpSurface = {
    enabled: value.enabled,
    server: nonemptyString(value.server, `${path}.server`),
    space: nonemptyString(value.space, `${path}.space`),
    harnesses: parseHarnesses(value.harnesses, `${path}.harnesses`),
  };
  if (
    surface.enabled &&
    (!surface.server || !hasSelectedHarnesses(surface.harnesses))
  ) {
    error(
      `${path} enabled surfaces require a server and at least one selected harness.`,
    );
  }
  return surface;
}

function parseCapture(
  value: unknown,
  path: string,
  scope: "defaults" | "directory",
): CaptureSurface {
  if (!isRecord(value)) error(`${path} must be an object.`);
  assertKeys(value, CAPTURE_KEYS, path);
  if (typeof value.enabled !== "boolean")
    error(`${path}.enabled must be a boolean.`);
  const tree = nonemptyString(value.tree, `${path}.tree`);
  const treeRoot = nonemptyString(value.tree_root, `${path}.tree_root`);
  if (tree && treeRoot)
    error(`${path} cannot contain both tree and tree_root.`);
  if (scope === "defaults" && tree)
    error(`${path}.tree is only valid in a directory profile.`);
  if (scope === "directory" && treeRoot)
    error(`${path}.tree_root is only valid in defaults.`);
  const surface: CaptureSurface = {
    enabled: value.enabled,
    server: nonemptyString(value.server, `${path}.server`),
    space: nonemptyString(value.space, `${path}.space`),
    tree,
    tree_root: treeRoot,
    harnesses: parseHarnesses(value.harnesses, `${path}.harnesses`),
  };
  if (surface.enabled) {
    if (
      !surface.server ||
      !surface.space ||
      !hasSelectedHarnesses(surface.harnesses)
    ) {
      error(
        `${path} enabled surfaces require a server, space, and at least one selected harness.`,
      );
    }
    if (scope === "defaults" && !surface.tree_root)
      error(`${path} requires tree_root.`);
    if (scope === "directory" && !surface.tree) error(`${path} requires tree.`);
  }
  return surface;
}

function parseCli(value: unknown, path: string): CliSurface {
  if (!isRecord(value)) error(`${path} must be an object.`);
  assertKeys(value, CLI_KEYS, path);
  const surface: CliSurface = {
    server: nonemptyString(value.server, `${path}.server`),
    space: nonemptyString(value.space, `${path}.space`),
    harnesses: parseHarnesses(value.harnesses, `${path}.harnesses`),
  };
  if (hasSelectedHarnesses(surface.harnesses) && !surface.server) {
    error(`${path} selected surfaces require a server.`);
  }
  return surface;
}

function parseProfile(
  value: unknown,
  path: string,
  scope: "defaults" | "directory",
): HarnessProfile {
  if (!isRecord(value)) error(`${path} must be an object.`);
  assertKeys(value, PROFILE_KEYS, path);
  return {
    ...(value.mcp === undefined
      ? {}
      : { mcp: parseMcp(value.mcp, `${path}.mcp`) }),
    ...(value.capture === undefined
      ? {}
      : { capture: parseCapture(value.capture, `${path}.capture`, scope) }),
    ...(value.cli === undefined
      ? {}
      : { cli: parseCli(value.cli, `${path}.cli`) }),
  };
}

/** Canonicalize existing paths physically and future paths lexically. */
export function canonicalizeDirectory(directory: string): string {
  let ancestor = resolve(directory);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(ancestor), ...missing);
    } catch (cause) {
      if (
        !(cause instanceof Error) ||
        !("code" in cause) ||
        cause.code !== "ENOENT"
      ) {
        throw cause;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) return resolve(ancestor, ...missing);
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function parseLocalConfig(raw: unknown): LocalConfig {
  if (!isRecord(raw)) error("the document must be an object.");
  if (raw.version !== undefined && raw.version !== 1)
    error("version must be 1.");
  if (raw.directories !== undefined && !isRecord(raw.directories))
    error("directories must be an object.");
  const directories: Record<string, HarnessProfile> = {};
  for (const [directory, profile] of Object.entries(raw.directories ?? {})) {
    if (
      !isAbsolute(directory) ||
      canonicalizeDirectory(directory) !== directory
    ) {
      error(`directory key "${directory}" must be an absolute canonical path.`);
    }
    directories[directory] = parseProfile(
      profile,
      `directories.${directory}`,
      "directory",
    );
  }
  return {
    version: 1,
    ...(raw.defaults === undefined
      ? {}
      : { defaults: parseProfile(raw.defaults, "defaults", "defaults") }),
    directories,
  };
}

function readRawConfig(): RawConfig {
  const path = getGlobalConfigPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = parse(readFileSync(path, "utf-8"));
    if (!isRecord(parsed)) error("the document must be an object.");
    return parsed;
  } catch (cause) {
    if (
      cause instanceof Error &&
      cause.message.startsWith("Invalid local config")
    )
      throw cause;
    error(
      `could not parse YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** Read and validate the harness-policy part of the global config. */
export function readLocalConfig(): LocalConfig {
  return parseLocalConfig(readRawConfig());
}

function migrateLegacyCapture(raw: RawConfig): void {
  if (
    raw.defaults !== undefined ||
    (raw.capture === undefined && raw.tree_root === undefined)
  )
    return;
  // The retired global capture switch had no harness selection. Preserve the
  // destination but keep it inactive until `me init` explicitly selects one.
  raw.defaults = {
    capture: {
      enabled: false,
      ...(typeof raw.tree_root === "string"
        ? { tree_root: raw.tree_root }
        : {}),
      harnesses: {},
    },
  };
  delete raw.capture;
  delete raw.tree_root;
}

function writeRawConfig(raw: RawConfig): void {
  const path = getGlobalConfigPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, stringify(raw, { lineWidth: 0 }), { mode: 0o600 });
  renameSync(temporary, path);
}

function writeProfile(profile: HarnessProfile, directory?: string): void {
  const raw = readRawConfig();
  migrateLegacyCapture(raw);
  const current = parseLocalConfig(raw);
  if (directory === undefined) {
    parseProfile(profile, "defaults", "defaults");
    raw.defaults = profile;
  } else {
    parseProfile(profile, `directories.${directory}`, "directory");
    raw.directories = { ...current.directories, [directory]: profile };
  }
  raw.version = 1;
  if (raw.directories === undefined) raw.directories = current.directories;
  parseLocalConfig(raw);
  writeRawConfig(raw);
}

/** Replace the complete defaults profile without touching human CLI state. */
export function writeDefaults(profile: HarnessProfile): void {
  writeProfile(profile);
}

/** Replace one complete, canonical directory profile. */
export function writeDirectoryProfile(
  directory: string,
  profile: HarnessProfile,
): void {
  writeProfile(profile, canonicalizeDirectory(directory));
}

function isAncestor(directory: string, cwd: string): boolean {
  return (
    directory === "/" ||
    cwd === directory ||
    cwd.startsWith(`${directory}${sep}`)
  );
}

function matchedProfile(
  config: LocalConfig,
  cwd: string,
): {
  source: "directory" | "defaults";
  path?: string;
  profile?: HarnessProfile;
} {
  let matched: string | undefined;
  for (const directory of Object.keys(config.directories)) {
    if (
      isAncestor(directory, cwd) &&
      (!matched || directory.length > matched.length)
    ) {
      matched = directory;
    }
  }
  if (matched)
    return {
      source: "directory",
      path: matched,
      profile: config.directories[matched],
    };
  return { source: "defaults", profile: config.defaults };
}

function resolveSurface<T>(
  source: "directory" | "defaults",
  profilePath: string | undefined,
  value: T | undefined,
): ResolvedSurface<T> {
  return value === undefined
    ? { source: "disabled" }
    : {
        source,
        ...(profilePath === undefined ? {} : { profile_path: profilePath }),
        value,
      };
}

export function resolveHarnessProfile(cwd: string): ResolvedHarnessProfile {
  const canonicalCwd = canonicalizeDirectory(cwd);
  const matched = matchedProfile(readLocalConfig(), canonicalCwd);
  return {
    cwd: canonicalCwd,
    profile_source: matched.source,
    ...(matched.path === undefined ? {} : { profile_path: matched.path }),
    mcp: resolveSurface(matched.source, matched.path, matched.profile?.mcp),
    capture: resolveSurface(
      matched.source,
      matched.path,
      matched.profile?.capture,
    ),
  };
}

export function resolveMcpProfile(cwd: string): ResolvedSurface<McpSurface> {
  return resolveHarnessProfile(cwd).mcp;
}

export function resolveCaptureProfile(
  cwd: string,
): ResolvedSurface<CaptureSurface> {
  return resolveHarnessProfile(cwd).capture;
}

export function resolveHarnessCliProfile(
  cwd: string,
  harness: HarnessName,
): ResolvedSurface<CliSurface> {
  const canonicalCwd = canonicalizeDirectory(cwd);
  const matched = matchedProfile(readLocalConfig(), canonicalCwd);
  const cli = matched.profile?.cli;
  if (!cli || cli.harnesses[harness] !== true) return { source: "disabled" };
  return resolveSurface(matched.source, matched.path, cli);
}

/** Remove one harness from every surface, pruning now-empty policy blocks. */
export function removeHarnessFromProfiles(harness: HarnessName): void {
  const raw = readRawConfig();
  migrateLegacyCapture(raw);
  const config = parseLocalConfig(raw);
  const pruneProfile = (
    profile: HarnessProfile,
  ): HarnessProfile | undefined => {
    const remove = <T extends { harnesses: HarnessSelection }>(
      surface: T | undefined,
    ): T | undefined => {
      if (!surface) return undefined;
      const harnesses = { ...surface.harnesses };
      delete harnesses[harness];
      return hasSelectedHarnesses(harnesses)
        ? { ...surface, harnesses }
        : undefined;
    };
    const next = {
      mcp: remove(profile.mcp),
      capture: remove(profile.capture),
      cli: remove(profile.cli),
    };
    return next.mcp || next.capture || next.cli ? next : undefined;
  };
  const defaults = config.defaults && pruneProfile(config.defaults);
  const directories = Object.fromEntries(
    Object.entries(config.directories).flatMap(([directory, profile]) => {
      const next = pruneProfile(profile);
      return next ? [[directory, next]] : [];
    }),
  );
  raw.version = 1;
  if (defaults) raw.defaults = defaults;
  else delete raw.defaults;
  raw.directories = directories;
  writeRawConfig(raw);
}
