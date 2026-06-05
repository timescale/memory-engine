/**
 * Credential + config storage — multi-server.
 *
 * Two files under $XDG_CONFIG_HOME/me (default ~/.config/me):
 *   - config.yaml      — non-secret: the default server + each server's active
 *                        space (the X-Me-Space).
 *   - credentials.yaml — 0600, secrets only: the session-token fallback, used
 *                        when no OS keychain is available (see ./keychain.ts);
 *                        empty / absent on hosts with a keychain.
 *
 * The session token (the one secret) prefers the OS keychain; the file is the
 * fallback. Api keys are never stored — agents get their key via `ME_API_KEY`
 * (or their MCP config); `apiKey.create` prints it once.
 *
 * config.yaml:
 * ```yaml
 * default_server: https://api.memory.build
 * servers:
 *   https://api.memory.build:
 *     active_space: abc123def456
 * ```
 * credentials.yaml (0600):
 * ```yaml
 * servers:
 *   https://api.memory.build:
 *     session_token: "..."   # only when there's no keychain
 * ```
 *
 * A pre-split credentials.yaml (which once held default_server + active_space
 * next to the token) is migrated to this layout on first read.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { keychainDelete, keychainGet, keychainSet } from "./keychain.ts";

// =============================================================================
// Constants & types
// =============================================================================

export const DEFAULT_SERVER = "https://api.memory.build";

/** Per-server non-secret config. */
export interface ServerConfig {
  /** Active space slug (the X-Me-Space). */
  active_space?: string;
}

/** config.yaml structure. */
export interface ConfigFile {
  default_server: string;
  servers: Record<string, ServerConfig>;
}

/** Per-server secrets — the keychain-free fallback. */
export interface ServerSecrets {
  session_token?: string;
}

/** credentials.yaml structure (secrets only). */
export interface CredentialsFile {
  servers: Record<string, ServerSecrets>;
}

/** Resolved credentials for a specific server. */
export interface ResolvedCredentials {
  server: string;
  sessionToken?: string;
  /** Agent api key — ME_API_KEY only; never persisted. */
  apiKey?: string;
  /** Active space slug (the X-Me-Space) — ME_SPACE env > stored active_space. */
  activeSpace?: string;
}

// =============================================================================
// Path Helpers
// =============================================================================

/** Config directory — respects $XDG_CONFIG_HOME, defaults to ~/.config/me. */
function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg || join(homedir(), ".config");
  return join(base, "me");
}

function getConfigPath(): string {
  return join(getConfigDir(), "config.yaml");
}

function getCredentialsPath(): string {
  return join(getConfigDir(), "credentials.yaml");
}

/**
 * Normalize a server URL to a canonical origin (scheme + host + port).
 * Strips trailing slashes and default ports.
 */
export function normalizeOrigin(url: string): string {
  // Defense in depth: this function gets called with values that flow in
  // from CLI flags, env vars, and YAML files. Throwing a clear error beats
  // a cryptic "url2.replace is not a function" downstream.
  if (typeof url !== "string") {
    throw new TypeError(
      `Expected server URL to be a string, got ${typeof url}`,
    );
  }
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }
    return parsed.origin;
  } catch {
    return url.replace(/\/+$/, "");
  }
}

// =============================================================================
// Read / Write
// =============================================================================

function ensureDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Read config.yaml (non-secret). Empty structure if absent / unparseable. */
function readConfig(): ConfigFile {
  migrateLegacyIfNeeded();
  const path = getConfigPath();
  if (!existsSync(path)) return { default_server: DEFAULT_SERVER, servers: {} };
  try {
    const data = parse(
      readFileSync(path, "utf-8"),
    ) as Partial<ConfigFile> | null;
    return {
      default_server: data?.default_server ?? DEFAULT_SERVER,
      servers: data?.servers ?? {},
    };
  } catch {
    return { default_server: DEFAULT_SERVER, servers: {} };
  }
}

/** Write config.yaml. Non-secret, but the dir is 0700 (owner-only). */
function writeConfig(config: ConfigFile): void {
  ensureDir();
  writeFileSync(getConfigPath(), stringify(config, { lineWidth: 0 }));
}

/** Read credentials.yaml (secrets). Empty structure if absent / unparseable. */
function readSecrets(): CredentialsFile {
  migrateLegacyIfNeeded();
  const path = getCredentialsPath();
  if (!existsSync(path)) return { servers: {} };
  try {
    const data = parse(
      readFileSync(path, "utf-8"),
    ) as Partial<CredentialsFile> | null;
    return { servers: data?.servers ?? {} };
  } catch {
    return { servers: {} };
  }
}

/** Write credentials.yaml with 0600 (owner read/write only). */
function writeSecrets(secrets: CredentialsFile): void {
  ensureDir();
  writeFileSync(getCredentialsPath(), stringify(secrets, { lineWidth: 0 }), {
    mode: 0o600,
  });
}

/**
 * One-time split of a pre-split credentials.yaml — which used to hold
 * default_server + per-server active_space alongside the token — into config.yaml
 * (non-secret) + a secret-only credentials.yaml. A no-op once config.yaml exists,
 * and when there's nothing legacy to move.
 */
function migrateLegacyIfNeeded(): void {
  if (existsSync(getConfigPath()) || !existsSync(getCredentialsPath())) return;

  let legacy: {
    default_server?: unknown;
    servers?: Record<
      string,
      { session_token?: unknown; active_space?: unknown }
    >;
  } | null;
  try {
    legacy = parse(readFileSync(getCredentialsPath(), "utf-8"));
  } catch {
    return;
  }
  if (!legacy || typeof legacy !== "object") return;

  const config: ConfigFile = {
    default_server:
      typeof legacy.default_server === "string"
        ? legacy.default_server
        : DEFAULT_SERVER,
    servers: {},
  };
  const secrets: CredentialsFile = { servers: {} };
  let sawLegacy = typeof legacy.default_server === "string";
  for (const [origin, entry] of Object.entries(legacy.servers ?? {})) {
    if (typeof entry?.active_space === "string") {
      config.servers[origin] = { active_space: entry.active_space };
      sawLegacy = true;
    }
    if (typeof entry?.session_token === "string") {
      secrets.servers[origin] = { session_token: entry.session_token };
    }
  }
  if (!sawLegacy) return; // already secret-only — nothing to migrate

  writeConfig(config);
  writeSecrets(secrets);
}

// =============================================================================
// Per-server accessors
// =============================================================================

/** Non-secret config for a server (active space). */
export function getServerConfig(server: string): ServerConfig {
  return readConfig().servers[normalizeOrigin(server)] ?? {};
}

/** Secrets for a server (the keychain-free session-token fallback). */
export function getServerSecrets(server: string): ServerSecrets {
  return readSecrets().servers[normalizeOrigin(server)] ?? {};
}

// =============================================================================
// Session token
// =============================================================================

/**
 * Store a session token for a server, and record it as the default server.
 * Prefers the OS keychain; only when that's unavailable does the token land in
 * the 0600 credentials file (and any stale file copy is dropped once the
 * keychain has it). The default server is non-secret config (config.yaml).
 */
export function storeSessionToken(server: string, token: string): void {
  const origin = normalizeOrigin(server);

  const secrets = readSecrets();
  if (keychainSet(origin, token)) {
    if (secrets.servers[origin]) {
      delete secrets.servers[origin]; // keychain is the source of truth
      writeSecrets(secrets);
    }
  } else {
    secrets.servers[origin] = { session_token: token };
    writeSecrets(secrets);
  }

  const config = readConfig();
  config.default_server = origin;
  writeConfig(config);
}

/**
 * Clear a server's session token from both the keychain and the file. Keeps
 * non-secret config (active space, default server). No-op for a token that came
 * from $ME_SESSION_TOKEN (we can't unset an env var the user controls).
 */
export function clearSessionToken(server: string): void {
  const origin = normalizeOrigin(server);
  keychainDelete(origin);

  const secrets = readSecrets();
  if (secrets.servers[origin]) {
    delete secrets.servers[origin];
    writeSecrets(secrets);
  }
}

/**
 * Log out of a server: clear its session secret (keychain + file) but keep the
 * non-secret config (active space, default server) so a re-login resumes where
 * you left off.
 */
export function clearServerCredentials(server: string): void {
  clearSessionToken(server);
}

// =============================================================================
// Active space (config)
// =============================================================================

/** Set the active space (the X-Me-Space) for a server. */
export function setActiveSpace(server: string, spaceSlug: string): void {
  const config = readConfig();
  const origin = normalizeOrigin(server);
  if (!config.servers[origin]) config.servers[origin] = {};
  config.servers[origin].active_space = spaceSlug;
  writeConfig(config);
}

/** Clear the active space for a server (e.g. after deleting it). No-op if unset. */
export function clearActiveSpace(server: string): void {
  const config = readConfig();
  const origin = normalizeOrigin(server);
  const entry = config.servers[origin];
  if (!entry?.active_space) return;
  delete entry.active_space;
  writeConfig(config);
}

/**
 * Resolve the active space slug for a server.
 * Priority: --space flag > ME_SPACE env > stored active_space.
 */
export function resolveSpace(
  server: string,
  flagValue?: string,
): string | undefined {
  if (flagValue) return flagValue;
  if (process.env.ME_SPACE) return process.env.ME_SPACE;
  return getServerConfig(server).active_space;
}

// =============================================================================
// Resolution
// =============================================================================

/**
 * Resolve the active server URL.
 * Priority: --server flag > ME_SERVER env > default_server (config) > DEFAULT_SERVER
 */
export function resolveServer(flagValue?: string): string {
  if (flagValue) return normalizeOrigin(flagValue);
  if (process.env.ME_SERVER) return normalizeOrigin(process.env.ME_SERVER);
  return readConfig().default_server;
}

/**
 * Resolve all credentials for the active server. The session token
 * (ME_SESSION_TOKEN env > file > keychain) authenticates humans; the active
 * space (ME_SPACE env > config) is the X-Me-Space. An agent api key is never
 * persisted — it only ever comes from ME_API_KEY.
 */
export function resolveCredentials(serverFlag?: string): ResolvedCredentials {
  const server = resolveServer(serverFlag);
  const origin = normalizeOrigin(server);
  const config = getServerConfig(server);
  const secrets = getServerSecrets(server);

  return {
    server,
    // env wins; then the file (keychain-free fallback); then the keychain. The
    // token lives in exactly one of file/keychain, so checking the file first
    // avoids a keychain lookup on hosts that use the file fallback.
    sessionToken:
      process.env.ME_SESSION_TOKEN ??
      secrets.session_token ??
      keychainGet(origin),
    apiKey: process.env.ME_API_KEY,
    activeSpace: process.env.ME_SPACE ?? config.active_space,
  };
}
