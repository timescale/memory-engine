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
const TOKEN_ENVS = [
  "ME_SESSION_TOKEN",
  "ME_SPACE",
  "ME_SERVER",
  "ME_API_KEY",
  "ME_AGENT",
];
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
  resetKeychainForTests();
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetKeychainForTests();
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

test("logout clears the secret but keeps the active space", () => {
  creds.storeTokens(SERVER, TOKENS);
  creds.setActiveSpace(SERVER, "abc123def456");
  creds.clearServerCredentials(SERVER); // logout
  const r = creds.resolveCredentials(SERVER);
  expect(r.loggedIn).toBe(false);
  expect(r.activeSpace).toBe("abc123def456"); // non-secret config survives logout
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

// =============================================================================
// resolveAgent — X-Me-Agent value (--agent flag > ME_AGENT env)
// =============================================================================

test("resolveAgent: explicit flag value wins and passes through verbatim", () => {
  process.env.ME_AGENT = "env-agent"; // flag beats env
  expect(creds.resolveAgent("my-agent")).toBe("my-agent");
  expect(creds.resolveAgent("019f0000-0000-7000-8000-000000000000")).toBe(
    "019f0000-0000-7000-8000-000000000000",
  );
});

test("resolveAgent: no flag + no env → undefined", () => {
  expect(creds.resolveAgent()).toBeUndefined();
  expect(creds.resolveAgent(undefined)).toBeUndefined();
});

test("resolveAgent: falls back to ME_AGENT env value", () => {
  process.env.ME_AGENT = "env-agent";
  expect(creds.resolveAgent()).toBe("env-agent");
});

test("resolveAgent: bare flag (true) throws not-implemented", () => {
  expect(() => creds.resolveAgent(true)).toThrow(/not implemented/i);
});

test("resolveAgent: empty-string flag throws not-implemented", () => {
  expect(() => creds.resolveAgent("")).toThrow(/not implemented/i);
});

test("resolveAgent: ME_AGENT=1 (bare env sentinel) throws not-implemented", () => {
  process.env.ME_AGENT = "1";
  expect(() => creds.resolveAgent()).toThrow(/not implemented/i);
});

test("resolveAgent: ME_AGENT empty string throws not-implemented", () => {
  process.env.ME_AGENT = "";
  expect(() => creds.resolveAgent()).toThrow(/not implemented/i);
});
