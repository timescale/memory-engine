/**
 * Unit tests for CLI utility helpers.
 *
 * Tests the space-model resolution functions with mocked clients.
 */
import { describe, expect, mock, test } from "bun:test";
import type { MemoryClient, UserClient } from "@memory.build/client";

// Dynamic import to avoid pulling in @clack/prompts at top level (it touches
// process.stdin).
const { resolveSpacePrincipalId, resolveAgentId } = await import("./util.ts");

const UUID = "019d694f-79f6-7595-8faf-b70b01c11f98";

// =============================================================================
// resolveSpacePrincipalId
// =============================================================================

describe("resolveSpacePrincipalId", () => {
  test("returns a UUIDv7 as-is without listing principals", async () => {
    const memory = {
      principal: { list: mock(() => Promise.reject(new Error("unused"))) },
    } as unknown as MemoryClient;
    expect(await resolveSpacePrincipalId(memory, UUID, "text")).toBe(UUID);
    expect(memory.principal.list).not.toHaveBeenCalled();
  });

  test("resolves a name via principal.list (with optional kind)", async () => {
    const memory = {
      principal: {
        list: mock(() =>
          Promise.resolve({
            principals: [{ id: UUID, kind: "g", name: "eng" }],
          }),
        ),
      },
    } as unknown as MemoryClient;

    const id = await resolveSpacePrincipalId(memory, "eng", "text", "g");
    expect(id).toBe(UUID);
    expect(memory.principal.list).toHaveBeenCalledWith({ kind: "g" });
  });
});

// =============================================================================
// resolveAgentId
// =============================================================================

describe("resolveAgentId", () => {
  test("returns a UUIDv7 as-is without listing agents", async () => {
    const user = {
      agent: { list: mock(() => Promise.reject(new Error("unused"))) },
    } as unknown as UserClient;
    expect(await resolveAgentId(user, UUID, "text")).toBe(UUID);
    expect(user.agent.list).not.toHaveBeenCalled();
  });

  test("resolves a name via agent.list", async () => {
    const user = {
      agent: {
        list: mock(() =>
          Promise.resolve({ agents: [{ id: UUID, name: "bot" }] }),
        ),
      },
    } as unknown as UserClient;

    expect(await resolveAgentId(user, "bot", "text")).toBe(UUID);
    expect(user.agent.list).toHaveBeenCalled();
  });
});
