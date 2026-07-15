/**
 * Tests for ensureDefaultAgent()'s install-time decision logic. The live server
 * owns the idempotency of principal.add / grant.set; these tests assert which
 * client calls the CLI makes for first install, stale config, and opt-outs.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("@clack/prompts", () => ({
  confirm: mock(async () => true),
  isCancel: () => false,
  log: { warn: mock() },
  note: mock(),
}));

import {
  getGlobalAgent,
  type ResolvedCredentials,
  setGlobalAgent,
} from "../credentials.ts";
import { resetKeychainForTests } from "../keychain.ts";

const { ensureDefaultAgent } = await import("./default-agent.ts");

type DefaultAgentClients = NonNullable<
  NonNullable<Parameters<typeof ensureDefaultAgent>[1]>["clients"]
>;

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

function fakeClients(agents: { id: string; name: string }[] = []): {
  clients: DefaultAgentClients;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const clients: DefaultAgentClients = {
    user: {
      agent: {
        list: async () => {
          calls.push(["agent.list"]);
          return { agents };
        },
        create: async (p) => {
          calls.push(["agent.create", p]);
          return { id: "agent-created" };
        },
      },
    },
    memory: {
      principal: {
        add: async (p) => {
          calls.push(["principal.add", p]);
          return { added: true };
        },
      },
      grant: {
        set: async (p) => {
          calls.push(["grant.set", p]);
          return { granted: true };
        },
      },
    },
  };
  return { clients, calls };
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

test("no-op when global agent is .user", async () => {
  setGlobalAgent(".user");
  await ensureDefaultAgent(creds({ loggedIn: true, activeSpace: "sp_abc" }));
  expect(getGlobalAgent()).toBe(".user");
});

test("no-op when a custom global agent already exists", async () => {
  setGlobalAgent("reviewer");
  const { clients, calls } = fakeClients([
    { id: "agent-reviewer", name: "reviewer" },
  ]);

  await ensureDefaultAgent(creds({ loggedIn: true, activeSpace: "sp_abc" }), {
    clients,
  });

  expect(calls).toEqual([["agent.list"]]);
  expect(getGlobalAgent()).toBe("reviewer");
});

test("no-op when not logged in", async () => {
  await ensureDefaultAgent(creds({ loggedIn: false, activeSpace: "sp_abc" }));
  expect(getGlobalAgent()).toBeUndefined();
});

test("no-op when there is no active space", async () => {
  await ensureDefaultAgent(creds({ loggedIn: true }));
  expect(getGlobalAgent()).toBeUndefined();
});

test("first install creates coder and writes it as the global default", async () => {
  const { clients, calls } = fakeClients();

  await ensureDefaultAgent(creds({ loggedIn: true, activeSpace: "sp_abc" }), {
    clients,
  });

  expect(calls).toEqual([
    ["agent.list"],
    ["agent.create", { name: "coder" }],
    ["principal.add", { principalId: "agent-created" }],
    ["grant.set", { principalId: "agent-created", treePath: "", access: 2 }],
  ]);
  expect(getGlobalAgent()).toBe("coder");
});

test("first install adopts an existing coder agent and writes its actual name", async () => {
  const { clients, calls } = fakeClients([
    { id: "agent-coder", name: "Coder" },
  ]);

  await ensureDefaultAgent(creds({ loggedIn: true, activeSpace: "sp_abc" }), {
    clients,
  });

  expect(calls).toEqual([
    ["agent.list"],
    ["principal.add", { principalId: "agent-coder" }],
    ["grant.set", { principalId: "agent-coder", treePath: "", access: 2 }],
  ]);
  expect(getGlobalAgent()).toBe("Coder");
});

test("stale global coder fails clearly in non-interactive installs", async () => {
  setGlobalAgent("coder");
  const { clients, calls } = fakeClients();

  await expect(
    ensureDefaultAgent(creds({ loggedIn: true, activeSpace: "sp_abc" }), {
      clients,
      interactive: false,
    }),
  ).rejects.toThrow("but you do not own an agent with that name or id");
  expect(calls).toEqual([["agent.list"]]);
  expect(getGlobalAgent()).toBe("coder");
});

test("stale global coder prompts and creates when confirmed", async () => {
  setGlobalAgent("coder");
  const { clients, calls } = fakeClients();
  const prompted: string[] = [];

  await ensureDefaultAgent(creds({ loggedIn: true, activeSpace: "sp_abc" }), {
    clients,
    interactive: true,
    confirmCreateConfiguredAgent: async (agent) => {
      prompted.push(agent);
      return true;
    },
  });

  expect(prompted).toEqual(["coder"]);
  expect(calls).toEqual([
    ["agent.list"],
    ["agent.create", { name: "coder" }],
    ["principal.add", { principalId: "agent-created" }],
    ["grant.set", { principalId: "agent-created", treePath: "", access: 2 }],
  ]);
  expect(getGlobalAgent()).toBe("coder");
});

test("stale global coder remains explicit when creation is declined", async () => {
  setGlobalAgent("coder");
  const { clients, calls } = fakeClients();

  await ensureDefaultAgent(creds({ loggedIn: true, activeSpace: "sp_abc" }), {
    clients,
    interactive: true,
    confirmCreateConfiguredAgent: async () => false,
  });

  expect(calls).toEqual([["agent.list"]]);
  expect(getGlobalAgent()).toBe("coder");
});

test("stale custom global agent can be created when confirmed", async () => {
  setGlobalAgent("reviewer");
  const { clients, calls } = fakeClients();

  await ensureDefaultAgent(creds({ loggedIn: true, activeSpace: "sp_abc" }), {
    clients,
    interactive: true,
    confirmCreateConfiguredAgent: async () => true,
  });

  expect(calls).toEqual([
    ["agent.list"],
    ["agent.create", { name: "reviewer" }],
    ["principal.add", { principalId: "agent-created" }],
    ["grant.set", { principalId: "agent-created", treePath: "", access: 2 }],
  ]);
  expect(getGlobalAgent()).toBe("reviewer");
});
