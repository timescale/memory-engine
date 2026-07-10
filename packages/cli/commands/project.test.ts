/**
 * Tests for `me project init`'s testable pieces: the agent-name prefill, the
 * provisioning call sequence (create → add to space → grant write at the
 * chosen scope), and the retired-command redirect (`createRemovedCommand`).
 * The prompt flow itself is interactive (clack) and exercised manually / via
 * the wizard's building blocks.
 */
import { describe, expect, test } from "bun:test";
import {
  type AgentProvisioningClients,
  provisionNewAgent,
} from "../agent/provision.ts";
import { createRemovedCommand, freeAgentName } from "./project.ts";

describe("freeAgentName", () => {
  test("prefers <slug>-agent when free", () => {
    expect(freeAgentName("my-repo", new Set())).toBe("my-repo-agent");
  });

  test("bumps to the next free -<n> variant, case-insensitively", () => {
    const taken = new Set(["my-repo-agent", "my-repo-agent-2"]);
    expect(freeAgentName("my-repo", taken)).toBe("my-repo-agent-3");
    expect(
      freeAgentName(
        "My-Repo".toLowerCase(),
        new Set(["MY-REPO-AGENT".toLowerCase()]),
      ),
    ).toBe("my-repo-agent-2");
  });
});

describe("provisionNewAgent", () => {
  /** Fake clients that record the calls in order. */
  function fakes(): { clients: AgentProvisioningClients; calls: unknown[] } {
    const calls: unknown[] = [];
    const clients: AgentProvisioningClients = {
      user: {
        agent: {
          create: async (p) => {
            calls.push(["agent.create", p]);
            return { id: "01920000-0000-7000-8000-000000000001" };
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

  test("whole-space: create → add → grant write at the root", async () => {
    const { clients, calls } = fakes();
    const id = await provisionNewAgent(clients, "repo-agent", "");
    expect(id).toBe("01920000-0000-7000-8000-000000000001");
    expect(calls).toEqual([
      ["agent.create", { name: "repo-agent" }],
      ["principal.add", { principalId: id }],
      ["grant.set", { principalId: id, treePath: "", access: 2 }],
    ]);
  });

  test("this-project: the grant lands on the project tree", async () => {
    const { clients, calls } = fakes();
    const id = await provisionNewAgent(
      clients,
      "repo-agent",
      "/share/projects/repo",
    );
    expect(calls[2]).toEqual([
      "grant.set",
      { principalId: id, treePath: "/share/projects/repo", access: 2 },
    ]);
  });

  test("a create failure aborts before any space mutation", async () => {
    const { clients, calls } = fakes();
    clients.user.agent.create = async () => {
      throw new Error("name taken");
    };
    await expect(provisionNewAgent(clients, "repo-agent", "")).rejects.toThrow(
      "name taken",
    );
    expect(calls).toEqual([]);
  });
});

describe("createRemovedCommand", () => {
  test("accepts any legacy flags, then errors and exits 1 without running anything", async () => {
    const cmd = createRemovedCommand("me claude init");
    const originalExit = process.exit;
    const originalError = console.error;
    const calls: { exitCode?: number; message?: string } = {};
    process.exit = ((code?: number) => {
      calls.exitCode = code;
    }) as never;
    console.error = (msg: string) => {
      calls.message = msg;
    };
    try {
      // A mix of flags no longer registered anywhere on this command —
      // Commander must not reject these itself (allowUnknownOption /
      // allowExcessArguments), or the action below never runs.
      await cmd.parseAsync(
        ["--scope", "project", "--skip-mcp-install", "--totally-unknown-flag"],
        { from: "user" },
      );
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
    expect(calls.exitCode).toBe(1);
    expect(calls.message).toContain("me claude init");
    expect(calls.message).toContain("has been removed");
    expect(calls.message).toContain("me project init");
  });
});
