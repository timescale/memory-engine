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
import {
  ProjectConfigError,
  resetProjectConfigCache,
  setConfigDirOverride,
} from "./project-config.ts";

const SERVER = "https://api.example.com";
const TOKENS: OAuthTokenSet = {
  access_token: "tok-123",
  refresh_token: "ref-456",
  expires_at: 1_750_000_000_000,
};
const TOKEN_ENVS = ["ME_SESSION_TOKEN", "ME_SPACE", "ME_SERVER", "ME_API_KEY"];
// Every env key these tests touch — snapshotted and restored so the ambient
// environment (and other test files in the same process) is left untouched.
const ENV_KEYS = [
  ...TOKEN_ENVS,
  "XDG_CONFIG_HOME",
  "ME_NO_KEYCHAIN",
  "ME_CONFIG_DIR",
];

let configDir: string;
/** A throwaway project dir; the `.me` resolver is pinned here (empty by default,
 *  so discovery is deterministic — no ambient `.me` from the repo ancestry). */
let projectDir: string;
let savedEnv: Record<string, string | undefined>;

/** Write a `.me/config.yaml` into the pinned project dir + refresh the cache. */
function writeMe(body: string): void {
  mkdirSync(join(projectDir, ".me"), { recursive: true });
  writeFileSync(join(projectDir, ".me", "config.yaml"), body);
  resetProjectConfigCache();
  setConfigDirOverride(projectDir);
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  configDir = mkdtempSync(join(tmpdir(), "me-creds-"));
  process.env.XDG_CONFIG_HOME = configDir;
  process.env.ME_NO_KEYCHAIN = "1"; // force the file fallback
  for (const k of TOKEN_ENVS) delete process.env[k];
  delete process.env.ME_CONFIG_DIR;
  resetKeychainForTests();

  // Pin the `.me` resolver at an empty throwaway dir so discovery is
  // deterministic (no walk-up into the repo/home) and off by default.
  projectDir = mkdtempSync(join(tmpdir(), "me-proj-"));
  resetProjectConfigCache();
  setConfigDirOverride(projectDir);
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetKeychainForTests();
  resetProjectConfigCache();
  setConfigDirOverride(undefined);
});

test(".me server is used when no --server flag / ME_SERVER env (whitelisted)", () => {
  writeMe(`server: ${creds.DEV_SERVER}\n`);
  expect(creds.resolveServer()).toBe(creds.DEV_SERVER);
});

test("ME_SERVER env still wins over a .me server", () => {
  writeMe("server: https://me-project.example.com\n");
  process.env.ME_SERVER = "https://env.example.com";
  // ME_SERVER short-circuits before the .me branch, so the untrusted .me
  // server is never resolved (or validated).
  expect(creds.resolveServer()).toBe("https://env.example.com");
});

test(".me may pin the prod server (default whitelist)", () => {
  writeMe(`server: ${creds.DEFAULT_SERVER}\n`);
  expect(creds.resolveServer()).toBe(creds.DEFAULT_SERVER);
});

test(".me pinning an untrusted server is a fatal error (credential-theft guard)", () => {
  writeMe("server: https://attacker.example\n");
  expect(() => creds.resolveServer()).toThrow(ProjectConfigError);
  expect(() => creds.resolveServer()).toThrow(
    /not in your trusted server list/,
  );
});

test("an explicit --server / ME_SERVER bypasses the whitelist (user's own choice)", () => {
  writeMe("server: https://attacker.example\n"); // untrusted .me present
  expect(creds.resolveServer("https://picked.example")).toBe(
    "https://picked.example",
  );
  process.env.ME_SERVER = "https://env-picked.example";
  expect(creds.resolveServer()).toBe("https://env-picked.example");
});

test("server_whitelist in the global config trusts an extra .me server", () => {
  mkdirSync(join(configDir, "me"), { recursive: true });
  writeFileSync(
    join(configDir, "me", "config.yaml"),
    "server_whitelist:\n  - https://internal.example.com\n",
  );
  writeMe("server: https://internal.example.com\n");
  expect(creds.resolveServer()).toBe("https://internal.example.com");
});

test("me login (storeTokens) trusts the server it logged into", () => {
  creds.storeTokens("https://loggedin.example.com", TOKENS);
  // getServerWhitelist now includes the logged-into server...
  expect(creds.getServerWhitelist()).toContain("https://loggedin.example.com");
  // ...so a .me pinning it is honored.
  writeMe("server: https://loggedin.example.com\n");
  expect(creds.resolveServer()).toBe("https://loggedin.example.com");
});

test("logging into prod/dev does not bloat server_whitelist (already trusted)", () => {
  creds.storeTokens(creds.DEFAULT_SERVER, TOKENS);
  // prod is a built-in default, so it isn't re-added; it appears exactly once.
  const wl = creds.getServerWhitelist();
  expect(wl.filter((s) => s === creds.DEFAULT_SERVER).length).toBe(1);
});

test("a non-string server_whitelist entry is a fatal config error", () => {
  mkdirSync(join(configDir, "me"), { recursive: true });
  writeFileSync(
    join(configDir, "me", "config.yaml"),
    "server_whitelist:\n  - 12345\n",
  );
  expect(() => creds.getServerWhitelist()).toThrow(/Invalid server_whitelist/);
});

test(".me server that isn't a valid http(s) URL fails with a clear error", () => {
  writeMe("server: not-a-url\n");
  expect(() => creds.resolveServer()).toThrow(ProjectConfigError);
  expect(() => creds.resolveServer()).toThrow(/invalid server/i);
});

test("a non-http(s) .me server scheme is rejected", () => {
  writeMe("server: ftp://api.memory.build\n");
  expect(() => creds.resolveServer()).toThrow(/must use http/i);
});

test("resolveServer normalizes a hand-edited default_server (trailing slash)", () => {
  mkdirSync(join(configDir, "me"), { recursive: true });
  writeFileSync(
    join(configDir, "me", "config.yaml"),
    "default_server: https://api.memory.build/\n",
  );
  // projectDir has no `.me` server, no flag/env → falls to default_server.
  expect(creds.resolveServer()).toBe("https://api.memory.build");
});

test(".me space drives resolveSpace + resolveCredentials.activeSpace", () => {
  writeMe("space: sp_from_me\n");
  expect(creds.resolveSpace(SERVER)).toBe("sp_from_me");
  expect(creds.resolveCredentials().activeSpace).toBe("sp_from_me");
});

test(".me tree surfaces as resolveCredentials.projectTree", () => {
  writeMe("tree: ~/projects/foo\n");
  expect(creds.resolveCredentials().projectTree).toBe("~/projects/foo");
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
