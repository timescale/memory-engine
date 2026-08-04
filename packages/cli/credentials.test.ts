/**
 * Credential storage tests — the file-fallback path.
 *
 * Forces the 0600-file fallback (ME_NO_KEYCHAIN) and an isolated XDG config dir
 * so the behavior is deterministic across platforms. The OS keychain backend is
 * exercised separately in keychain.test.ts.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthTokenSet } from "./credentials.ts";
import * as creds from "./credentials.ts";
import { resetKeychainForTests } from "./keychain.ts";

const SERVER = "https://api.example.com";
const TOKENS: OAuthTokenSet = {
  access_token: "tok-123",
  refresh_token: "ref-456",
  expires_at: 1_750_000_000_000,
};
const TOKEN_ENVS = ["ME_SESSION_TOKEN", "ME_SPACE", "ME_SERVER", "ME_API_KEY"];
// Every env key these tests touch — snapshotted and restored so the ambient
// environment (and other test files in the same process) is left untouched.
const ENV_KEYS = [...TOKEN_ENVS, "XDG_CONFIG_HOME", "ME_NO_KEYCHAIN"];

let configDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  configDir = mkdtempSync(join(tmpdir(), "me-creds-"));
  process.env.XDG_CONFIG_HOME = configDir;
  process.env.ME_NO_KEYCHAIN = "1"; // force the file fallback
  for (const k of TOKEN_ENVS) delete process.env[k];
  creds.setServerFlagOverride(undefined);
  resetKeychainForTests();
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  creds.setServerFlagOverride(undefined);
  resetKeychainForTests();
});

test("resolveServer normalizes a hand-edited default_server (trailing slash)", () => {
  mkdirSync(join(configDir, "me"), { recursive: true });
  writeFileSync(
    join(configDir, "me", "config.yaml"),
    "default_server: https://api.memory.build/\n",
  );
  // No flag or env → falls to default_server.
  expect(creds.resolveServer()).toBe("https://api.memory.build");
});

test("store + read an OAuth token set (file fallback)", () => {
  creds.storeTokens(SERVER, TOKENS);
  const r = creds.resolveCredentials(SERVER);
  expect(r.server).toBe(SERVER);
  expect(r.loggedIn).toBe(true);
  expect(creds.getStoredTokens(SERVER)).toEqual(TOKENS);
  // fallback stores the set in the secrets file (no keychain)
  expect(creds.getServerSecrets(SERVER).tokens?.access_token).toBe("tok-123");
});

test("the credentials file is written 0600", () => {
  creds.storeTokens(SERVER, TOKENS);
  const file = join(configDir, "me", "credentials.yaml");
  expect(existsSync(file)).toBe(true);
  // low 9 permission bits = rw------- (0o600)
  expect(statSync(file).mode & 0o777).toBe(0o600);
  // sanity: the access token is actually in the file in fallback mode
  expect(readFileSync(file, "utf-8")).toContain("tok-123");
});

test("clearTokens removes the token set", () => {
  creds.storeTokens(SERVER, TOKENS);
  creds.clearTokens(SERVER);
  expect(creds.resolveCredentials(SERVER).loggedIn).toBe(false);
  expect(creds.getStoredTokens(SERVER)).toBeUndefined();
});

test("ME_SESSION_TOKEN env marks the server logged in (no stored set needed)", () => {
  expect(creds.resolveCredentials(SERVER).loggedIn).toBe(false);
  process.env.ME_SESSION_TOKEN = "from-env";
  expect(creds.resolveCredentials(SERVER).loggedIn).toBe(true);
});

test("active space: set / resolve / clear; ME_SPACE wins", () => {
  creds.setActiveSpace(SERVER, "abc123def456");
  expect(creds.resolveCredentials(SERVER).activeSpace).toBe("abc123def456");

  process.env.ME_SPACE = "envspace0001";
  expect(creds.resolveCredentials(SERVER).activeSpace).toBe("envspace0001");
  delete process.env.ME_SPACE;

  creds.clearActiveSpace(SERVER);
  expect(creds.resolveCredentials(SERVER).activeSpace).toBeUndefined();
});

test("harness CLI space applies only to its selected server", () => {
  creds.setHarnessCliOverride({ server: SERVER, space: "profile-space" });
  try {
    expect(creds.resolveCredentials(SERVER).activeSpace).toBe("profile-space");
    expect(creds.resolveSpace("https://other.example.com")).toBeUndefined();
    expect(
      creds.resolveCredentials("https://other.example.com").activeSpace,
    ).toBeUndefined();
  } finally {
    creds.setHarnessCliOverride(undefined);
  }
});

test("logout clears the secret but keeps the active space", () => {
  creds.storeTokens(SERVER, TOKENS);
  creds.setActiveSpace(SERVER, "abc123def456");
  creds.clearServerCredentials(SERVER); // logout
  const r = creds.resolveCredentials(SERVER);
  expect(r.loggedIn).toBe(false);
  expect(r.activeSpace).toBe("abc123def456"); // non-secret config survives logout
});

test("setDefaultServer persists the default server without touching secrets", () => {
  creds.setDefaultServer("https://picked.example.com/");
  expect(creds.getDefaultServer()).toBe("https://picked.example.com");
  // No secrets side effects: nothing stored, still logged out.
  expect(creds.resolveCredentials().loggedIn).toBe(false);
  expect(creds.resolveCredentials().server).toBe("https://picked.example.com");
});

test("human CLI writes preserve harness policy fields", () => {
  const path = join(configDir, "me", "config.yaml");
  mkdirSync(join(configDir, "me"), { recursive: true });
  writeFileSync(
    path,
    [
      "version: 1",
      "defaults:",
      "  mcp:",
      "    enabled: false",
      "    harnesses: {}",
      "directories: {}",
    ].join("\n"),
  );

  creds.setActiveSpace(SERVER, "abc123def456");

  const config = readFileSync(path, "utf-8");
  expect(config).toContain("version: 1");
  expect(config).toContain("directories: {}");
  expect(config).toContain("active_space: abc123def456");
});

test("legacy ME_AS_AGENT env is inert — never bleeds into ResolvedCredentials", () => {
  // The env var is a phase-1/phase-2 removal; a stale value in a shell or
  // CI job must not resurrect act-as-agent behavior in the client.
  process.env.ME_AS_AGENT = "stale-agent";
  try {
    const resolved = creds.resolveCredentials(SERVER);
    expect(resolved).not.toHaveProperty("asAgent");
  } finally {
    delete process.env.ME_AS_AGENT;
  }
});

test("secrets and config live in separate files", () => {
  creds.storeTokens(SERVER, {
    access_token: "tok-sep",
    refresh_token: "ref-sep",
  });
  creds.setActiveSpace(SERVER, "abc123def456");
  const configFile = readFileSync(
    join(configDir, "me", "config.yaml"),
    "utf-8",
  );
  const credsFile = readFileSync(
    join(configDir, "me", "credentials.yaml"),
    "utf-8",
  );
  // config.yaml has the active space (non-secret), not the token
  expect(configFile).toContain("abc123def456");
  expect(configFile).not.toContain("tok-sep");
  // credentials.yaml has the token set (fallback), not the active space
  expect(credsFile).toContain("tok-sep");
  expect(credsFile).not.toContain("abc123def456");
});

test("migrates a legacy credentials.yaml: salvages config, scrubs the dead token", () => {
  // a pre-split credentials.yaml that bundled a (now-retired) device-flow
  // session_token together with the non-secret config
  const dir = join(configDir, "me");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "credentials.yaml"),
    [
      `default_server: ${SERVER}`,
      "servers:",
      `  ${SERVER}:`,
      "    session_token: legacy-tok",
      "    active_space: legacyspace1",
    ].join("\n"),
    { mode: 0o600 },
  );

  // reading salvages the non-secret bits; the dead device token is dropped
  const r = creds.resolveCredentials();
  expect(r.server).toBe(SERVER);
  expect(r.activeSpace).toBe("legacyspace1");
  expect(r.loggedIn).toBe(false); // the retired session_token is not honored

  // config.yaml now holds the non-secret bits; credentials.yaml is scrubbed
  const configFile = readFileSync(join(dir, "config.yaml"), "utf-8");
  expect(configFile).toContain("legacyspace1");
  const credsFile = readFileSync(join(dir, "credentials.yaml"), "utf-8");
  expect(credsFile).not.toContain("legacy-tok"); // scrubbed from disk
  expect(credsFile).not.toContain("legacyspace1");
});
