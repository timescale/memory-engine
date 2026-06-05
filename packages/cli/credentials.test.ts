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
import * as creds from "./credentials.ts";
import { resetKeychainForTests } from "./keychain.ts";

const SERVER = "https://api.example.com";
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

test("store + resolve a session token (file fallback)", () => {
  creds.storeSessionToken(SERVER, "tok-123");
  const r = creds.resolveCredentials(SERVER);
  expect(r.server).toBe(SERVER);
  expect(r.sessionToken).toBe("tok-123");
  // fallback stores the token in the secrets file (no keychain)
  expect(creds.getServerSecrets(SERVER).session_token).toBe("tok-123");
});

test("the credentials file is written 0600", () => {
  creds.storeSessionToken(SERVER, "tok");
  const file = join(configDir, "me", "credentials.yaml");
  expect(existsSync(file)).toBe(true);
  // low 9 permission bits = rw------- (0o600)
  expect(statSync(file).mode & 0o777).toBe(0o600);
  // sanity: the token is actually in the file in fallback mode
  expect(readFileSync(file, "utf-8")).toContain("tok");
});

test("clearSessionToken removes the token", () => {
  creds.storeSessionToken(SERVER, "tok-123");
  creds.clearSessionToken(SERVER);
  expect(creds.resolveCredentials(SERVER).sessionToken).toBeUndefined();
});

test("ME_SESSION_TOKEN env overrides the stored token", () => {
  creds.storeSessionToken(SERVER, "stored");
  process.env.ME_SESSION_TOKEN = "from-env";
  expect(creds.resolveCredentials(SERVER).sessionToken).toBe("from-env");
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
  creds.storeSessionToken(SERVER, "tok");
  creds.setActiveSpace(SERVER, "abc123def456");
  creds.clearServerCredentials(SERVER); // logout
  const r = creds.resolveCredentials(SERVER);
  expect(r.sessionToken).toBeUndefined();
  expect(r.activeSpace).toBe("abc123def456"); // non-secret config survives logout
});

test("secrets and config live in separate files", () => {
  creds.storeSessionToken(SERVER, "tok-sep");
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
  // credentials.yaml has the token (fallback), not the active space
  expect(credsFile).toContain("tok-sep");
  expect(credsFile).not.toContain("abc123def456");
});

test("migrates a legacy credentials.yaml (token + active_space + default)", () => {
  // a pre-split credentials.yaml that bundled everything together
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

  // reading resolves all three, migrating the non-secret bits out
  const r = creds.resolveCredentials();
  expect(r.server).toBe(SERVER);
  expect(r.sessionToken).toBe("legacy-tok");
  expect(r.activeSpace).toBe("legacyspace1");

  // config.yaml now exists with the non-secret bits; credentials.yaml is
  // secret-only (no active_space left behind)
  const configFile = readFileSync(join(dir, "config.yaml"), "utf-8");
  expect(configFile).toContain("legacyspace1");
  const credsFile = readFileSync(join(dir, "credentials.yaml"), "utf-8");
  expect(credsFile).toContain("legacy-tok");
  expect(credsFile).not.toContain("legacyspace1");
});
