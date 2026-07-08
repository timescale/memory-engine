/**
 * Tests for ensureDefaultAgent()'s no-op guard clauses — the branches that
 * adopt/create an agent need a live server and are covered by
 * provisionNewAgent's own unit tests (commands/project.test.ts) plus manual
 * verification (see HARNESS_DESIGN.md's verification matrix).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getGlobalAgent,
  type ResolvedCredentials,
  setGlobalAgent,
} from "../credentials.ts";
import { resetKeychainForTests } from "../keychain.ts";
import { ensureDefaultAgent } from "./default-agent.ts";

let configDir: string;

function creds(
  overrides: Partial<ResolvedCredentials> = {},
): ResolvedCredentials {
  return {
    server: "https://api.example.com",
    loggedIn: false,
    captureEnabled: false,
    ...overrides,
  };
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "me-default-agent-"));
  process.env.XDG_CONFIG_HOME = configDir;
  process.env.ME_NO_KEYCHAIN = "1";
  resetKeychainForTests();
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.ME_NO_KEYCHAIN;
  resetKeychainForTests();
});

test("no-op when the credential is an agent api key (sandboxed mode)", async () => {
  await ensureDefaultAgent(creds({ apiKey: "me.lookup.secret" }));
  expect(getGlobalAgent()).toBeUndefined();
});

test("no-op when a global agent is already set (incl. .user)", async () => {
  setGlobalAgent(".user");
  await ensureDefaultAgent(creds({ loggedIn: true, activeSpace: "sp_abc" }));
  expect(getGlobalAgent()).toBe(".user");
});

test("no-op when not logged in", async () => {
  await ensureDefaultAgent(creds({ loggedIn: false, activeSpace: "sp_abc" }));
  expect(getGlobalAgent()).toBeUndefined();
});

test("no-op when there is no active space", async () => {
  await ensureDefaultAgent(creds({ loggedIn: true }));
  expect(getGlobalAgent()).toBeUndefined();
});
