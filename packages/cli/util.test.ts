/**
 * Unit tests for CLI utility helpers.
 *
 * Tests resolution functions with mocked clients.
 */
import { describe, expect, mock, test } from "bun:test";
import type { EngineClient } from "@memory.build/client";

// We test the exported functions via dynamic import to avoid
// pulling in @clack/prompts at top level (it touches process.stdin).
const { resolveUserId } = await import("./util.ts");

// =============================================================================
// resolveUserId
// =============================================================================

describe("resolveUserId", () => {
  test("returns UUID as-is when input is a valid UUIDv7", async () => {
    const engine = {} as EngineClient; // should not be called
    const id = "019d694f-79f6-7595-8faf-b70b01c11f98";
    const result = await resolveUserId(engine, id);
    expect(result).toBe(id);
  });

  test("resolves name via engine.user.getByName", async () => {
    const engine = {
      user: {
        getByName: mock(() =>
          Promise.resolve({
            id: "019d694f-79f6-7595-8faf-b70b01c11f98",
            name: "alice",
          }),
        ),
      },
    } as unknown as EngineClient;

    const result = await resolveUserId(engine, "alice");
    expect(result).toBe("019d694f-79f6-7595-8faf-b70b01c11f98");
    expect(engine.user.getByName).toHaveBeenCalledWith({ name: "alice" });
  });
});
