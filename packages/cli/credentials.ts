/**
 * Credential + config storage — multi-server.
 *
 * Two files under $XDG_CONFIG_HOME/me (default ~/.config/me):
 *   - config.yaml      — non-secret: the default server + each server's active
 *                        space (the X-Me-Space).
 *   - credentials.yaml — 0600, secrets only: the OAuth token-set fallback, used
 *                        when no OS keychain is available (see ./keychain.ts);
 *                        empty / absent on hosts with a keychain.
 *
 * The secret a human persists is the OAuth token set ({@link OAuthTokenSet} —
 * access token + refresh token + expiry), obtained by `me login`. It prefers the
 * OS keychain (stored as JSON under the server origin); the file is the fallback.
 * Api keys are never stored — agents get their key via `ME_API_KEY` (or their MCP
 * config); `apiKey.create` prints it once.
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
 *     tokens:                  # only when there's no keychain
 *       access_token: "..."
 *       refresh_token: "..."
 *       expires_at: 1750000000000
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
import { getProjectConfig } from "./project-config.ts";

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

/**
 * The OAuth token set a human holds after `me login` — an auth-code+PKCE grant
 * against the server's OAuth 2.1 authorization server. The access token is the
 * bearer for RPC calls; the refresh token mints fresh ones (rotated on use).
 */
export interface OAuthTokenSet {
  /** Short-lived bearer for the memory/user RPC endpoints. */
  access_token: string;
  /** Long-lived; exchanged for a new access token. Absent → no silent refresh. */
  refresh_token?: string;
  /** Absolute expiry of the access token (epoch ms), for proactive refresh. */
  expires_at?: number;
  /** Granted scope string, informational. */
  scope?: string;
}

/** Per-server secrets — the keychain-free fallback. */
export interface ServerSecrets {
  tokens?: OAuthTokenSet;
}

/** credentials.yaml structure (secrets only). */
export interface CredentialsFile {
  servers: Record<string, ServerSecrets>;
}

/** Resolved credentials for a specific server. */
export interface ResolvedCredentials {
  server: string;
  /**
   * Whether a human is logged in here — a stored token set exists (or
   * ME_SESSION_TOKEN overrides). The actual (possibly refreshed) access token is
   * resolved lazily by `session.ts`, never returned synchronously here.
   */
  loggedIn: boolean;
  /** Agent api key — ME_API_KEY only; never persisted. */
  apiKey?: string;
  /** Active space slug (the X-Me-Space) — ME_SPACE > `.me` space > stored active_space. */
  activeSpace?: string;
  /**
   * The full project-tree root from a `.me/config.yaml` in scope, if any — used
   * by integrations (capture hooks, git import) as the project root, nesting
   * under it without appending a slug. Undefined when there is no `.me`.
   */
  projectTree?: string;
  /**
   * Act-as-agent target — a concrete agent id/name to send as `X-Me-As-Agent`,
   * resolved from `--as-agent` / `ME_AS_AGENT` (the `.me` sentinel already
   * substituted for `.me/config.yaml`'s `agent`). Undefined when the mode is off
   * (activation is always explicit — a `.me` `agent` alone never enables it).
   */
  asAgent?: string;
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
  let sawLegacy = typeof legacy.default_server === "string";
  for (const [origin, entry] of Object.entries(legacy.servers ?? {})) {
    if (typeof entry?.active_space === "string") {
      config.servers[origin] = { active_space: entry.active_space };
      sawLegacy = true;
    }
  }
  if (!sawLegacy) return; // already secret-only — nothing to migrate

  // Salvage only the non-secret config. Any legacy `session_token` was a
  // device-flow session, retired by the OAuth cutover — drop it (writing an
  // empty secrets file scrubs the dead token from disk); the user re-runs
  // `me login` to mint an OAuth token set.
  writeConfig(config);
  writeSecrets({ servers: {} });
}

// =============================================================================
// Per-server accessors
// =============================================================================

/** Non-secret config for a server (active space). */
export function getServerConfig(server: string): ServerConfig {
  return readConfig().servers[normalizeOrigin(server)] ?? {};
}

/** Secrets for a server (the keychain-free token-set fallback). */
export function getServerSecrets(server: string): ServerSecrets {
  return readSecrets().servers[normalizeOrigin(server)] ?? {};
}

// =============================================================================
// OAuth token set
// =============================================================================

/**
 * Store an OAuth token set for a server, and record it as the default server.
 * Prefers the OS keychain (the token set is serialized to JSON under the server
 * origin); only when that's unavailable does it land in the 0600 credentials
 * file (and any stale file copy is dropped once the keychain has it). The
 * default server is non-secret config (config.yaml).
 */
export function storeTokens(server: string, tokens: OAuthTokenSet): void {
  const origin = normalizeOrigin(server);

  const secrets = readSecrets();
  if (keychainSet(origin, JSON.stringify(tokens))) {
    if (secrets.servers[origin]) {
      delete secrets.servers[origin]; // keychain is the source of truth
      writeSecrets(secrets);
    }
  } else {
    secrets.servers[origin] = { tokens };
    writeSecrets(secrets);
  }

  const config = readConfig();
  config.default_server = origin;
  writeConfig(config);
}

/**
 * Read the stored OAuth token set for a server (keychain first, else the file
 * fallback). Returns undefined when absent or unparseable (e.g. a pre-OAuth
 * plaintext value in the keychain) — the caller then prompts a re-login.
 */
export function getStoredTokens(server: string): OAuthTokenSet | undefined {
  const origin = normalizeOrigin(server);

  // File fallback (keychain-free hosts) is checked first: the token lives in
  // exactly one of file/keychain, so this avoids a keychain lookup there.
  const fromFile = getServerSecrets(server).tokens;
  if (fromFile?.access_token) return fromFile;

  const raw = keychainGet(origin);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as OAuthTokenSet;
    return parsed && typeof parsed.access_token === "string"
      ? parsed
      : undefined;
  } catch {
    return undefined; // legacy plaintext token or corrupt entry → re-login
  }
}

/** True iff a usable stored token set exists for the server. */
export function hasStoredTokens(server: string): boolean {
  return getStoredTokens(server) !== undefined;
}

/**
 * Clear a server's token set from both the keychain and the file. Keeps
 * non-secret config (active space, default server). No-op for tokens injected
 * via $ME_SESSION_TOKEN (we can't unset an env var the user controls).
 */
export function clearTokens(server: string): void {
  const origin = normalizeOrigin(server);
  keychainDelete(origin);

  const secrets = readSecrets();
  if (secrets.servers[origin]) {
    delete secrets.servers[origin];
    writeSecrets(secrets);
  }
}

/**
 * Log out of a server: clear its token set (keychain + file) but keep the
 * non-secret config (active space, default server) so a re-login resumes where
 * you left off.
 */
export function clearServerCredentials(server: string): void {
  clearTokens(server);
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
 * Priority: --space flag > ME_SPACE env > `.me` space > stored active_space.
 */
export function resolveSpace(
  server: string,
  flagValue?: string,
): string | undefined {
  if (flagValue) return flagValue;
  if (process.env.ME_SPACE) return process.env.ME_SPACE;
  const projectSpace = getProjectConfig()?.space;
  if (projectSpace) return projectSpace;
  return getServerConfig(server).active_space;
}

// =============================================================================
// Act-as-agent (X-Me-As-Agent)
// =============================================================================

/**
 * The literal `.me` sentinel for `--as-agent` / `ME_AS_AGENT`: "use the
 * project's agent". Substituted client-side for `.me/config.yaml`'s `agent` id;
 * never sent to the server. `.me` is a DB-impossible agent name (agent names
 * match `^[A-Za-z0-9]…`, so they can never start with `.`), so it can't shadow a
 * real agent.
 */
const AS_AGENT_PROJECT_SENTINEL = ".me";

/** The `--as-agent` global-flag value, seeded once from the root preAction hook. */
let asAgentOverride: string | undefined;

/**
 * Seed the `--as-agent` override (called once from the root `preAction` hook,
 * before any command resolves credentials) so it is ambiently visible to
 * {@link resolveAsAgent} without threading `globalOpts` through every command.
 * Mirrors {@link setConfigDirOverride}.
 */
export function setAsAgentOverride(value: string | undefined): void {
  asAgentOverride = value;
}

/**
 * Whether act-as-agent mode was explicitly requested by flag or env. This does
 * not resolve the `.me` sentinel, so local session-management commands can
 * refuse agent mode without consulting project config.
 */
export function isAsAgentRequested(): boolean {
  return Boolean(asAgentOverride ?? process.env.ME_AS_AGENT);
}

/**
 * Resolve the act-as-agent target (the `X-Me-As-Agent` value), highest first:
 *   1. the `--as-agent` flag override (from `preAction`),
 *   2. the `ME_AS_AGENT` env,
 *   3. otherwise `undefined` (mode OFF).
 *
 * Activation is always explicit: when neither the flag nor env is present, the
 * mode stays off even if a `.me/config.yaml` `agent` is in scope. When the value
 * is the literal `.me` sentinel it resolves to that `.me` `agent` (throwing if
 * none is in scope); any other value is an explicit agent id/name, verbatim.
 */
export function resolveAsAgent(): string | undefined {
  const raw = asAgentOverride ?? process.env.ME_AS_AGENT;
  if (!raw) return undefined;
  if (raw === AS_AGENT_PROJECT_SENTINEL) {
    const agent = getProjectConfig()?.agent;
    if (!agent) {
      throw new Error(
        "--as-agent .me needs an 'agent:' in .me/config.yaml, but none is in scope",
      );
    }
    return agent;
  }
  return raw;
}

// =============================================================================
// Resolution
// =============================================================================

/**
 * Resolve the active server URL.
 * Priority: --server flag > ME_SERVER env > `.me` server > default_server (config) > DEFAULT_SERVER
 */
export function resolveServer(flagValue?: string): string {
  if (flagValue) return normalizeOrigin(flagValue);
  if (process.env.ME_SERVER) return normalizeOrigin(process.env.ME_SERVER);
  const projectServer = getProjectConfig()?.server;
  if (projectServer) return normalizeOrigin(projectServer);
  return readConfig().default_server;
}

/**
 * Resolve all credentials for the active server. A human is "logged in" when a
 * token set is stored (or ME_SESSION_TOKEN overrides) — the live access token
 * is resolved lazily (with refresh) by `session.ts`, not here. The active space
 * (ME_SPACE env > config) is the X-Me-Space. An agent api key is never
 * persisted — it only ever comes from ME_API_KEY.
 */
export function resolveCredentials(serverFlag?: string): ResolvedCredentials {
  const server = resolveServer(serverFlag);
  const config = getServerConfig(server);
  const project = getProjectConfig();

  return {
    server,
    loggedIn: Boolean(process.env.ME_SESSION_TOKEN) || hasStoredTokens(server),
    apiKey: process.env.ME_API_KEY,
    activeSpace: process.env.ME_SPACE ?? project?.space ?? config.active_space,
    projectTree: project?.tree,
    asAgent: resolveAsAgent(),
  };
}
