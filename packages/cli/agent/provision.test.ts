/**
 * Tests for ensureAgentInSpace() — the membership+grant primitive shared by
 * provisionNewAgent's "create" path and ensureDefaultAgent's "adopt an
 * existing agent" path (see agent/default-agent.ts). provisionNewAgent's own
 * call-sequence tests live in commands/project.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { ensureAgentInSpace } from "./provision.ts";

/** Fake memory-client slice that records the calls in order. */
function fakeMemory() {
  const calls: unknown[] = [];
  const memory = {
    principal: {
      add: async (p: { principalId: string }) => {
        calls.push(["principal.add", p]);
        return { added: true };
      },
    },
    grant: {
      set: async (p: {
        principalId: string;
        treePath: string;
        access: number;
      }) => {
        calls.push(["grant.set", p]);
        return { granted: true };
      },
    },
  };
  return { memory, calls };
}

describe("ensureAgentInSpace", () => {
  test("adds the principal to the space and grants write at the tree path", async () => {
    const { memory, calls } = fakeMemory();
    await ensureAgentInSpace({ memory }, "agent-1", "");
    expect(calls).toEqual([
      ["principal.add", { principalId: "agent-1" }],
      ["grant.set", { principalId: "agent-1", treePath: "", access: 2 }],
    ]);
  });

  test("passes through a non-root tree path", async () => {
    const { memory, calls } = fakeMemory();
    await ensureAgentInSpace({ memory }, "agent-2", "/share/projects/foo");
    expect(calls).toEqual([
      ["principal.add", { principalId: "agent-2" }],
      [
        "grant.set",
        { principalId: "agent-2", treePath: "/share/projects/foo", access: 2 },
      ],
    ]);
  });

  test("is safe to call again for an agent already added and granted (idempotent)", async () => {
    const { memory, calls } = fakeMemory();
    await ensureAgentInSpace({ memory }, "agent-3", "");
    await ensureAgentInSpace({ memory }, "agent-3", "");
    expect(calls).toHaveLength(4);
  });
});
