/**
 * Credential storage — multi-server, multi-engine credential management.
 *
 * Stores session tokens and per-engine API keys in
 * $XDG_CONFIG_HOME/me/credentials.yaml (default: ~/.config/me/).
 *
 * File format:
 * ```yaml
 * default_server: https://api.memory.build
 * servers:
 *   https://api.memory.build:
 *     session_token: "..."
 *     active_engine: "abc123defg45"
 *     engines:
 *       abc123defg45:
 *         api_key: "me.abc123defg45.xxxx.yyyy"
 *       xyz789qwer12:
 *         api_key: "me.xyz789qwer12.xxxx.yyyy"
 * ```
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_SERVER = "https://api.memory.build";

// =============================================================================
// Types
// =============================================================================

/**
 * Per-engine credential entry.
 */
export interface EngineCredentials {
  api_key: string;
}

/**
 * Per-server credential entry.
 */
export interface ServerCredentials {
  session_token?: string;
  active_engine?: string;
  engines?: Record<string, EngineCredentials>;
}

/**
 * Full credentials file structure.
 */
export interface CredentialsFile {
  default_server: string;
  servers: Record<string, ServerCredentials>;
}

/**
 * Resolved credentials for a specific server.
 */
export interface ResolvedCredentials {
  server: string;
  sessionToken?: string;
  apiKey?: string;
  activeEngine?: string;
}

// =============================================================================
// Path Helpers
// =============================================================================

/**
 * Get the config directory path.
 * Respects $XDG_CONFIG_HOME, defaults to ~/.config/me.
 */
function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg || join(homedir(), ".config");
  return join(base, "me");
}

/**
 * Get the credentials file path.
 */
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
    // Remove default ports
    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }
    // Return origin (scheme + host + port, no trailing slash)
    return parsed.origin;
  } catch {
    // If URL parsing fails, return as-is with trailing slash stripped
    return url.replace(/\/+$/, "");
  }
}

// =============================================================================
// Read / Write
// =============================================================================

/**
 * Read the credentials file. Returns empty structure if file doesn't exist.
 */
export function readCredentials(): CredentialsFile {
  const path = getCredentialsPath();
  if (!existsSync(path)) {
    return {
      default_server: DEFAULT_SERVER,
      servers: {},
    };
  }

  try {
    const content = readFileSync(path, "utf-8");
    const data = parse(content) as Partial<CredentialsFile> | null;
    return {
      default_server: data?.default_server ?? DEFAULT_SERVER,
      servers: data?.servers ?? {},
    };
  } catch {
    return {
      default_server: DEFAULT_SERVER,
      servers: {},
    };
  }
}

/**
 * Write the credentials file atomically with secure permissions.
 * Creates the config directory if it doesn't exist.
 */
export function writeCredentials(creds: CredentialsFile): void {
  const dir = getConfigDir();
  const path = getCredentialsPath();

  // Create config directory with 0700 (owner-only)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const content = stringify(creds, { lineWidth: 0 });

  // Write with 0600 (owner read/write only)
  writeFileSync(path, content, { mode: 0o600 });
}

// =============================================================================
// Server Credential Operations
// =============================================================================

/**
 * Get credentials for a specific server.
 */
export function getServerCredentials(server: string): ServerCredentials {
  const creds = readCredentials();
  const origin = normalizeOrigin(server);
  return creds.servers[origin] ?? {};
}

/**
 * Store a session token for a server.
 * Also sets this server as the default.
 */
export function storeSessionToken(server: string, token: string): void {
  const creds = readCredentials();
  const origin = normalizeOrigin(server);

  if (!creds.servers[origin]) {
    creds.servers[origin] = {};
  }
  creds.servers[origin].session_token = token;
  creds.default_server = origin;

  writeCredentials(creds);
}

/**
 * Store an API key for an engine on a server.
 * Also sets the engine as active.
 */
export function storeApiKey(
  server: string,
  engineSlug: string,
  apiKey: string,
): void {
  const creds = readCredentials();
  const origin = normalizeOrigin(server);

  if (!creds.servers[origin]) {
    creds.servers[origin] = {};
  }
  if (!creds.servers[origin].engines) {
    creds.servers[origin].engines = {};
  }
  creds.servers[origin].engines[engineSlug] = { api_key: apiKey };
  creds.servers[origin].active_engine = engineSlug;

  writeCredentials(creds);
}

// Like storeApiKey, but does NOT touch active_engine. Used by the MCP server
// when provisioning a key in-session: the binding lives in process memory and
// must not change which engine the next CLI process treats as active.
export function addEngineApiKey(
  server: string,
  engineSlug: string,
  apiKey: string,
): void {
  const creds = readCredentials();
  const origin = normalizeOrigin(server);

  if (!creds.servers[origin]) {
    creds.servers[origin] = {};
  }
  if (!creds.servers[origin].engines) {
    creds.servers[origin].engines = {};
  }
  creds.servers[origin].engines[engineSlug] = { api_key: apiKey };

  writeCredentials(creds);
}

/**
 * Set the active engine for a server (without modifying API keys).
 */
export function setActiveEngine(server: string, engineSlug: string): void {
  const creds = readCredentials();
  const origin = normalizeOrigin(server);

  if (!creds.servers[origin]) {
    creds.servers[origin] = {};
  }
  creds.servers[origin].active_engine = engineSlug;

  writeCredentials(creds);
}

/**
 * Get the API key for a specific engine on a server.
 */
export function getEngineApiKey(
  server: string,
  engineSlug: string,
): string | undefined {
  const stored = getServerCredentials(server);
  return stored.engines?.[engineSlug]?.api_key;
}

/**
 * Engine slug parsed from a `me.<slug>.<keyId>.<secret>` API key.
 */
export function parseEngineSlugFromKey(apiKey: string): string | undefined {
  const parts = apiKey.split(".");
  if (parts.length < 4 || parts[0] !== "me") return undefined;
  return parts[1];
}

/**
 * Clear just the session token for a server, leaving any stored engines and
 * API keys in place. Used after the server tells us the session is expired so
 * the next command surfaces "Not logged in" instead of repeating the 401.
 *
 * No-op if no credentials are stored for the server, or if the token came
 * from $ME_SESSION_TOKEN (we can't unset an env var the user controls).
 */
export function clearSessionToken(server: string): void {
  const creds = readCredentials();
  const origin = normalizeOrigin(server);

  const entry = creds.servers[origin];
  if (!entry?.session_token) {
    return;
  }
  delete entry.session_token;

  writeCredentials(creds);
}

/**
 * Clear all credentials for a server.
 */
export function clearServerCredentials(server: string): void {
  const creds = readCredentials();
  const origin = normalizeOrigin(server);

  delete creds.servers[origin];

  // If we just cleared the default server, reset to default
  if (creds.default_server === origin) {
    creds.default_server = DEFAULT_SERVER;
  }

  writeCredentials(creds);
}

// =============================================================================
// Resolution
// =============================================================================

/**
 * Resolve the active server URL.
 *
 * Priority: --server flag > ME_SERVER env > default_server in creds > DEFAULT_SERVER
 */
export function resolveServer(flagValue?: string): string {
  if (flagValue) return normalizeOrigin(flagValue);
  if (process.env.ME_SERVER) return normalizeOrigin(process.env.ME_SERVER);

  const creds = readCredentials();
  return creds.default_server;
}

/**
 * Resolve all credentials for the active server.
 *
 * For each credential type, env vars take priority over the stored file.
 * API key is resolved from the active engine's stored key.
 */
export function resolveCredentials(serverFlag?: string): ResolvedCredentials {
  const server = resolveServer(serverFlag);
  const stored = getServerCredentials(server);

  // Resolve API key: env var > active engine's stored key
  const activeEngine = stored.active_engine;
  const storedApiKey = activeEngine
    ? stored.engines?.[activeEngine]?.api_key
    : undefined;

  return {
    server,
    sessionToken: process.env.ME_SESSION_TOKEN ?? stored.session_token,
    apiKey: process.env.ME_API_KEY ?? storedApiKey,
    activeEngine,
  };
}
