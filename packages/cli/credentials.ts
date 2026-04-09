/**
 * Credential storage — multi-server credential management.
 *
 * Stores session tokens and API keys per server in
 * $XDG_CONFIG_HOME/me/credentials.yaml (default: ~/.config/me/).
 *
 * File format:
 * ```yaml
 * default_server: https://memory.build
 * servers:
 *   https://memory.build:
 *     session_token: "..."
 *     api_key: "me.abc.xyz"
 *   http://localhost:3000:
 *     session_token: "..."
 *     api_key: "me.def.uvw"
 * ```
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_SERVER = "https://memory.build";

// =============================================================================
// Types
// =============================================================================

/**
 * Per-server credential entry.
 */
export interface ServerCredentials {
  session_token?: string;
  api_key?: string;
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
 * Store an API key for a server.
 */
export function storeApiKey(server: string, apiKey: string): void {
  const creds = readCredentials();
  const origin = normalizeOrigin(server);

  if (!creds.servers[origin]) {
    creds.servers[origin] = {};
  }
  creds.servers[origin].api_key = apiKey;

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
 */
export function resolveCredentials(serverFlag?: string): ResolvedCredentials {
  const server = resolveServer(serverFlag);
  const stored = getServerCredentials(server);

  return {
    server,
    sessionToken: process.env.ME_SESSION_TOKEN ?? stored.session_token,
    apiKey: process.env.ME_API_KEY ?? stored.api_key,
  };
}
