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
 * API keys are never stored; `apiKey.create` prints them once.
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
 * next to the token) has its non-secret config salvaged on first config read.
 * Retired session_token values are ignored, and replaced at the next login;
 * synchronous readers never rewrite a whole shared credentials file unlocked.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import {
  type CredentialAuthority,
  canonicalCredentialPath,
  credentialCoordinationDir,
  credentialHomeDir,
  inaccessibleCredentialFile,
  publishCredentialAuthority,
  readCredentialAuthority,
} from "./credential-authority.ts";
import {
  keychainAvailable,
  keychainDelete,
  keychainRead,
  keychainSet,
} from "./keychain.ts";

// =============================================================================
// Constants & types
// =============================================================================

export const DEFAULT_SERVER = "https://api.memory.build";
/** The shared dev deployment. */
export const DEV_SERVER = "https://me.dev-us-east-1.ops.dev.timescale.com";

/** Per-server non-secret config. */
export interface ServerConfig {
  /** Active space slug (the X-Me-Space). */
  active_space?: string;
}

/** config.yaml structure. */
export interface ConfigFile {
  /** Preserve policy and future top-level fields this module does not own. */
  [key: string]: unknown;
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
  /**
   * Terminal invalid_grant tombstone: SHA-256 of the rejected refresh token.
   * Written under the per-origin refresh lock; the raw refresh token is removed.
   * Kept in the same keychain/file record so a new login replaces it naturally.
   */
  refresh_rejected?: string;
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
  /** API key — ME_API_KEY only; never persisted. */
  apiKey?: string;
  /** Active space slug (the X-Me-Space). */
  activeSpace?: string;
}

// =============================================================================
// Path Helpers
// =============================================================================

/** Config directory — respects $XDG_CONFIG_HOME, defaults to ~/.config/me. */
function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg || join(credentialHomeDir(), ".config");
  return join(base, "me");
}

function getConfigPath(): string {
  return join(getConfigDir(), "config.yaml");
}

/** User-facing path to the global non-secret config file. */
export function getGlobalConfigPath(): string {
  return getConfigPath();
}

/** Canonical physical fallback pathname, also the whole-file lock identity. */
export function getCredentialsPath(): string {
  return canonicalCredentialPath(join(getConfigDir(), "credentials.yaml"));
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

/**
 * Absolute path for a named lock (a directory used as a cross-process mutex) in
 * the config dir, ensuring the dir exists. The session layer serializes token
 * refreshes on such a lock so concurrent `me` processes on one host don't race
 * the rotating refresh token (see session.ts).
 */
export function getConfigLockPath(name: string): string {
  ensureDir();
  return join(getConfigDir(), name);
}

/**
 * Credential mutations must share a lock even across different XDG config dirs:
 * those dirs still address the same per-user OS keychain record. When a backend
 * exists (even temporarily unavailable), use a stable home-relative lock root.
 * File-only stores retain XDG isolation, including ME_NO_KEYCHAIN test stores.
 */
export function getCredentialLockPath(
  name: string,
  createDirectory = true,
): string {
  if (!keychainAvailable())
    return createDirectory
      ? getConfigLockPath(name)
      : join(getConfigDir(), name);
  // Retain the legacy default-store location so older clients using the
  // default config directory still coordinate with upgraded keychain clients.
  const dir = credentialCoordinationDir();
  if (createDirectory) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, name);
}

/**
 * Write `contents` to `path` atomically: write a sibling temp file, fsync-free
 * `rename` over the target (atomic on POSIX), and clean up the temp on failure.
 * A crash mid-write can then never leave a torn/truncated config or credentials
 * file (which readers would treat as unparseable → surprise re-login). Mirrors
 * the inventory writer in harness/installations.ts.
 */
function writeFileAtomic(
  path: string,
  contents: string,
  mode: number | undefined,
): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, mode !== undefined ? { mode } : {});
    renameSync(temporaryPath, path);
  } finally {
    // Best-effort cleanup. A failing unlink here would otherwise mask the
    // original write/rename error (or throw over an already-successful write);
    // swallow it so callers see the real cause and no stale temp accumulates
    // beyond one leaked file per crash (each has a UUID name, so reads never
    // touch it).
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // ignore
    }
  }
}

/** Read config.yaml (non-secret). Empty structure if absent / unparseable. */
function readConfig(): ConfigFile {
  migrateLegacyIfNeeded();
  const path = getConfigPath();
  if (!existsSync(path)) return { default_server: DEFAULT_SERVER, servers: {} };
  let data: Record<string, unknown> | null;
  try {
    data = parse(readFileSync(path, "utf-8")) as Record<string, unknown> | null;
  } catch {
    return { default_server: DEFAULT_SERVER, servers: {} };
  }
  return {
    ...data,
    default_server:
      typeof data?.default_server === "string"
        ? data.default_server
        : DEFAULT_SERVER,
    servers: (data?.servers as ConfigFile["servers"]) ?? {},
  };
}

/** Write config.yaml. Non-secret, but the dir is 0700 (owner-only). */
function writeConfig(config: ConfigFile): void {
  ensureDir();
  writeFileAtomic(
    getConfigPath(),
    stringify(config, { lineWidth: 0 }),
    undefined,
  );
}

type SecretsRead =
  | { status: "found"; value: CredentialsFile }
  | { status: "missing" }
  | { status: "unavailable" };

/** Unlike absence, unreadable/corrupt storage is not evidence of logout. */
function readSecretsState(path = getCredentialsPath()): SecretsRead {
  try {
    const data: unknown = parse(readFileSync(path, "utf-8"));
    if (data == null) return { status: "found", value: { servers: {} } };
    if (typeof data !== "object" || Array.isArray(data))
      return { status: "unavailable" };
    const servers = (data as Partial<CredentialsFile>).servers;
    if (
      servers != null &&
      (typeof servers !== "object" || Array.isArray(servers))
    )
      return { status: "unavailable" };
    return { status: "found", value: { servers: servers ?? {} } };
  } catch (error) {
    return {
      status:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "unavailable",
    };
  }
}

/** Compatibility view for config readers; mutation/read decisions use state. */
function readSecrets(): CredentialsFile {
  const result = readSecretsState();
  return result.status === "found" ? result.value : { servers: {} };
}

/** Write credentials.yaml with 0600 (owner read/write only). */
function writeSecrets(
  secrets: CredentialsFile,
  path = getCredentialsPath(),
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, stringify(secrets, { lineWidth: 0 }), 0o600);
}

/**
 * Salvage non-secret config from a pre-split credentials.yaml. Do not rewrite
 * the shared secret file from a synchronous read: a writer in another process
 * may have just committed a login/rotation. Retired session_token fields are
 * ignored by token readers and replaced on explicit login under the file lock.
 */
function migrateLegacyIfNeeded(): void {
  if (existsSync(getConfigPath()) || !existsSync(getCredentialsPath())) return;

  let legacy: {
    default_server?: unknown;
    servers?: Record<
      string,
      { session_token?: unknown; active_space?: unknown; tokens?: unknown }
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

  writeConfig(config);
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

/** Preserve unavailable vs missing, especially after a successful exchange. */
export type StoredTokensRead =
  | { status: "found"; tokens: OAuthTokenSet }
  | { status: "missing" }
  | { status: "unavailable" };

function validatedTokens(value: unknown): StoredTokensRead {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as OAuthTokenSet).access_token === "string" &&
    (value as OAuthTokenSet).access_token
  )
    return { status: "found", tokens: value as OAuthTokenSet };
  return { status: "unavailable" };
}

/** Backend primitives; mutation callers must hold the corresponding resources. */
export function readFileTokens(origin: string, path: string): StoredTokensRead {
  const file = readSecretsState(path);
  if (file.status !== "found") return file;
  const entry = file.value.servers[origin];
  if (entry == null) return { status: "missing" };
  if (typeof entry !== "object" || Array.isArray(entry))
    return { status: "unavailable" };
  return entry.tokens == null
    ? { status: "missing" }
    : validatedTokens(entry.tokens);
}

export function readKeychainTokens(origin: string): StoredTokensRead {
  const result = keychainRead(origin);
  if (result.status !== "found") return result;
  try {
    return validatedTokens(JSON.parse(result.value));
  } catch {
    return { status: "unavailable" };
  }
}

export function readTokensFromAuthority(
  origin: string,
  authority: CredentialAuthority,
): StoredTokensRead {
  switch (authority.source) {
    case "keychain":
      return readKeychainTokens(origin);
    case "file":
      return readFileTokens(origin, authority.path);
    case "logged_out":
      return { status: "missing" };
  }
}

/** Only the current legacy XDG path is considered; never scan other directories. */
export function readLegacyCredentialSource(
  origin: string,
  fallbackPath: string,
): { result: StoredTokensRead; authority?: CredentialAuthority } {
  const file = readFileTokens(origin, fallbackPath);
  // Released clients selected the current XDG file before consulting keychain:
  // a failed keychain write legitimately leaves an older keychain record behind.
  // Preserve that precedence on adoption, without inferring wall-clock ordering.
  if (file.status === "unavailable") return { result: file };
  if (file.status === "found")
    return {
      result: file,
      authority: { version: 1, source: "file", path: fallbackPath },
    };
  const keychain = readKeychainTokens(origin);
  if (keychain.status === "unavailable") return { result: keychain };
  if (keychain.status === "found")
    return { result: keychain, authority: { version: 1, source: "keychain" } };
  return {
    result: { status: "missing" },
    authority: { version: 1, source: "logged_out" },
  };
}

/** Readers follow published authority ONLY, even when its backend is missing. */
export function readStoredTokens(server: string): StoredTokensRead {
  try {
    const origin = normalizeOrigin(server);
    if (!keychainAvailable())
      return readFileTokens(origin, getCredentialsPath());
    const published = readCredentialAuthority(origin);
    if (published.status === "unavailable") return { status: "unavailable" };
    if (published.status === "found")
      return readTokensFromAuthority(origin, published.authority);
    return readLegacyCredentialSource(origin, getCredentialsPath()).result;
  } catch {
    return { status: "unavailable" };
  }
}

export function getStoredTokens(server: string): OAuthTokenSet | undefined {
  const result = readStoredTokens(server);
  return result.status === "found" ? result.tokens : undefined;
}

/** True iff a usable stored token set exists for the server. */
export function hasStoredTokens(server: string): boolean {
  return getStoredTokens(server) !== undefined;
}

/** Refuse destructive read/modify/write of an unreadable or corrupt file. */
function writableSecrets(path: string): CredentialsFile {
  const stored = readSecretsState(path);
  if (stored.status === "unavailable")
    throw new Error(
      "Credential store cannot be read; no credentials were changed.",
    );
  return stored.status === "found" ? stored.value : { servers: {} };
}

function writeFileTokens(
  origin: string,
  path: string,
  tokens: OAuthTokenSet,
): void {
  const secrets = writableSecrets(path);
  secrets.servers[origin] = { tokens };
  writeSecrets(secrets, path);
}

export function retireFileTokens(origin: string, path: string): void {
  const secrets = writableSecrets(path);
  if (secrets.servers[origin]) {
    delete secrets.servers[origin];
    writeSecrets(secrets, path);
  }
}

/** @internal A destination pinned BEFORE exchange, while all resources are held. */
export interface CredentialWriteTarget {
  keychain: boolean;
  authority: CredentialAuthority;
  fallbackPath: string;
  retirePaths: string[];
  /** Only paths whose resource lock was actually acquired may be written. */
  lockedPaths: string[];
  /** Explicit keychain login/logout may leave unreadable private files alone. */
  recoverUnreadableFiles?: boolean;
}

/**
 * Background writes never promote an active file to keychain. Keychain failure
 * may demote to the already-locked fallback, publishing only after it is saved.
 * Publication failure is a write failure, even if the destination write worked.
 */
export function writeCurrentTokens(
  server: string,
  tokens: OAuthTokenSet,
  target: CredentialWriteTarget,
): void {
  const origin = normalizeOrigin(server);
  if (target.authority.source === "logged_out")
    throw new Error(
      "Credentials were removed. Run 'me login' to sign in again.",
    );
  if (target.authority.source === "file") {
    writeFileTokens(origin, target.authority.path, tokens);
    return;
  }
  if (keychainSet(origin, JSON.stringify(tokens))) return;
  if (!target.lockedPaths.includes(target.fallbackPath))
    throw new Error("Credential fallback is not locked; no file was changed.");
  const existingFile = readSecretsState(target.fallbackPath);
  const existing = readFileTokens(origin, target.fallbackPath);
  const hasEntry =
    existingFile.status === "found" &&
    Object.hasOwn(existingFile.value.servers, origin);
  // This XDG may contain a separate file-only login, or an unpublished rotation
  // saved before a failed authority publication. Neither may be overwritten by
  // a background rotation or an old-token rejection tombstone.
  if (
    existingFile.status === "unavailable" ||
    existing.status === "unavailable" ||
    (hasEntry &&
      (existing.status !== "found" ||
        !sameTokenRecord(existing.tokens, tokens)))
  )
    throw new Error(
      "Credential fallback contains different or unreadable credentials; no file was changed.",
    );
  writeFileTokens(origin, target.fallbackPath, tokens);
  const next: CredentialAuthority = {
    version: 1,
    source: "file",
    path: target.fallbackPath,
  };
  publishCredentialAuthority(origin, next);
  target.authority = next;
}

function sameTokenRecord(left: OAuthTokenSet, right: OAuthTokenSet): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(
    (key) =>
      (left as unknown as Record<string, unknown>)[key] ===
      (right as unknown as Record<string, unknown>)[key],
  );
}

/**
 * Select only readable files for explicit keychain retirement. Corrupt or
 * inaccessible private files cannot be safely rewritten; canonical authority
 * publication retires them for global keychain readers, NOT file-only clients.
 */
function retirementPaths(target: CredentialWriteTarget): string[] {
  return target.retirePaths.filter((path) => {
    if (target.recoverUnreadableFiles && target.keychain)
      return readSecretsState(path).status !== "unavailable";
    writableSecrets(path);
    return true;
  });
}

/**
 * Low-level explicit login. Production uses persistLoginTokens, which supplies
 * a pinned target and holds the canonical origin + whole-file resource locks.
 * API keys are never passed here. Healthy keychain writes create no token file.
 */
export function storeTokens(
  server: string,
  tokens: OAuthTokenSet,
  options?: { setDefault?: boolean; target?: CredentialWriteTarget },
): void {
  const origin = normalizeOrigin(server);
  const target = options?.target ?? unlockedWriteTarget(origin);
  // Readable active files MUST be retired before publication. Unreadable files
  // may be left untouched only for explicit canonical keychain recovery.
  const retirePaths = retirementPaths(target);
  let next: CredentialAuthority;
  if (target.keychain && keychainSet(origin, JSON.stringify(tokens))) {
    for (const path of retirePaths) retireFileTokens(origin, path);
    next = { version: 1, source: "keychain" };
  } else {
    if (!target.lockedPaths.includes(target.fallbackPath))
      throw new Error(
        "Credential fallback cannot be locked. Restore access to its directory or unlock the OS keychain, then retry.",
      );
    writeFileTokens(origin, target.fallbackPath, tokens);
    for (const path of retirePaths)
      if (path !== target.fallbackPath) retireFileTokens(origin, path);
    next = { version: 1, source: "file", path: target.fallbackPath };
  }
  if (target.keychain) publishCredentialAuthority(origin, next);
  target.authority = next;
  if (options?.setDefault !== false) {
    try {
      setDefaultServer(origin);
    } catch (error) {
      if (
        !target.recoverUnreadableFiles ||
        next.source !== "keychain" ||
        !inaccessibleCredentialFile(error)
      )
        throw error;
      // The global keychain login has safely committed. An inaccessible private
      // XDG must not prevent recovery just because its non-secret config cannot
      // be updated. Do not invent another config path or claim it was saved.
      console.warn(
        "Credentials saved, but the default server could not be updated. Restore access to XDG_CONFIG_HOME; use --server to select this login meanwhile.",
      );
    }
  }
}

/** Synchronous compatibility primitives require the SAME locks as production. */
function unlockedWriteTarget(origin: string): CredentialWriteTarget {
  const fallbackPath = getCredentialsPath();
  const keychain = keychainAvailable();
  const published = keychain ? readCredentialAuthority(origin) : undefined;
  if (published?.status === "unavailable")
    throw new Error(
      "Credential authority cannot be read. Restore access to ~/.config/me, then retry login or logout.",
    );
  const authority =
    published?.status === "found"
      ? published.authority
      : { version: 1 as const, source: "file" as const, path: fallbackPath };
  const paths = [
    ...new Set([
      fallbackPath,
      ...(authority.source === "file" ? [authority.path] : []),
    ]),
  ].sort();
  return {
    keychain,
    authority,
    fallbackPath,
    retirePaths: paths,
    // Compatibility callers are responsible for holding these same locks.
    lockedPaths: paths,
  };
}

/** Retire shared files, then publish durable logout BEFORE keychain deletion. */
export function clearTokens(
  server: string,
  pinned?: CredentialWriteTarget,
): void {
  const origin = normalizeOrigin(server);
  const target = pinned ?? unlockedWriteTarget(origin);
  for (const path of retirementPaths(target)) retireFileTokens(origin, path);
  const next: CredentialAuthority = { version: 1, source: "logged_out" };
  if (target.keychain) {
    publishCredentialAuthority(origin, next);
    keychainDelete(origin); // best effort: surviving secrets are now unreachable
  }
  target.authority = next;
}

/** Keep non-secret config (active space/default server) on explicit logout. */
export function clearServerCredentials(server: string): void {
  clearTokens(server);
}

// =============================================================================
// Active space (config)
// =============================================================================

/**
 * Persist the default server (config.yaml `default_server`) without touching
 * secrets. `me login` (storeTokens) does this as part of storing a token set;
 * this is the standalone writer for flows that pin the currently-resolved
 * server as a global default (e.g. `me claude install`).
 */
export function setDefaultServer(server: string): void {
  const config = readConfig();
  config.default_server = normalizeOrigin(server);
  writeConfig(config);
}

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
 * Priority: --space flag > ME_SPACE env > selected harness CLI profile > stored active_space.
 */
export function resolveSpace(
  server: string,
  flagValue?: string,
): string | undefined {
  if (flagValue) return flagValue;
  if (process.env.ME_SPACE) return process.env.ME_SPACE;
  const harnessSpace = harnessSpaceFor(server);
  if (harnessSpace) return harnessSpace;
  return getServerConfig(server).active_space;
}

// =============================================================================
// --server flag (seeded)
// =============================================================================

/**
 * The root `--server` flag, seeded once from the root `preAction` hook.
 * Seeding lets commands resolve the flag without threading it through every
 * credential callsite.
 */
let serverFlagOverride: string | undefined;
let harnessCliOverride: { server?: string; space?: string } | undefined;

/** Seed the `--server` flag override (called once from `preAction`). */
export function setServerFlagOverride(value: string | undefined): void {
  serverFlagOverride = value;
}

/** Seeded once for a known harness shell selected by machine-local policy. */
export function setHarnessCliOverride(
  value: { server?: string; space?: string } | undefined,
): void {
  harnessCliOverride = value;
}

function harnessSpaceFor(server: string): string | undefined {
  if (!harnessCliOverride?.server || !harnessCliOverride.space)
    return undefined;
  return normalizeOrigin(harnessCliOverride.server) === normalizeOrigin(server)
    ? harnessCliOverride.space
    : undefined;
}

// =============================================================================
// Resolution
// =============================================================================

/**
 * Resolve the active server URL.
 * Priority: --server flag > ME_SERVER env > selected harness CLI profile > default_server (config) > DEFAULT_SERVER
 *
 * A selected harness profile is machine-local policy. Explicit flags and
 * environment variables remain higher precedence; ordinary human CLI calls do
 * not read directory profiles. Every branch returns a normalized origin.
 */
export function resolveServer(flagValue?: string): string {
  const flag = flagValue ?? serverFlagOverride;
  if (flag) return normalizeOrigin(flag);
  if (process.env.ME_SERVER) return normalizeOrigin(process.env.ME_SERVER);
  if (harnessCliOverride?.server)
    return normalizeOrigin(harnessCliOverride.server);
  return normalizeOrigin(readConfig().default_server);
}

/**
 * The global default server (config.yaml), ignoring flags and env.
 */
export function getDefaultServer(): string {
  return normalizeOrigin(readConfig().default_server);
}

/**
 * Resolve all credentials for the active server. A human is "logged in" when a
 * token set is stored (or ME_SESSION_TOKEN overrides) — the live access token
 * is resolved lazily (with refresh) by `session.ts`, not here. The active space
 * (ME_SPACE env > config) is the X-Me-Space. API keys are never persisted —
 * they only ever come from ME_API_KEY.
 */
export function resolveCredentials(serverFlag?: string): ResolvedCredentials {
  const server = resolveServer(serverFlag);
  const config = readConfig();

  return {
    server,
    loggedIn: Boolean(process.env.ME_SESSION_TOKEN) || hasStoredTokens(server),
    apiKey: process.env.ME_API_KEY,
    activeSpace:
      process.env.ME_SPACE ??
      harnessSpaceFor(server) ??
      config.servers[normalizeOrigin(server)]?.active_space,
  };
}
