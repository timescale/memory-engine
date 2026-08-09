/** Unit tests for group CLI command helpers. */
import { describe, expect, mock, test } from "bun:test";
import type { MemoryClient } from "@memory.build/client";
import { resolveGroupId } from "./group.ts";

const UUID = "019d694f-79f6-7595-8faf-b70b01c11f98";

describe("resolveGroupId", () => {
  test("resolves a group name through member-accessible principal.resolve", async () => {
    const resolve = mock(() =>
      Promise.resolve({
        principals: [{ id: UUID, kind: "g" as const, name: "engineering" }],
      }),
    );
    const list = mock(() => Promise.reject(new Error("unused")));
    const memory = {
      principal: { resolve },
      group: { list },
    } as unknown as MemoryClient;

    await expect(resolveGroupId(memory, "engineering", "text")).resolves.toBe(
      UUID,
    );
    expect(resolve).toHaveBeenCalledWith({ name: "engineering", kind: "g" });
    expect(list).not.toHaveBeenCalled();
  });

  test("returns a UUIDv7 without resolving", async () => {
    const resolve = mock(() => Promise.reject(new Error("unused")));
    const memory = {
      principal: { resolve },
    } as unknown as MemoryClient;

    await expect(resolveGroupId(memory, UUID, "text")).resolves.toBe(UUID);
    expect(resolve).not.toHaveBeenCalled();
  });
});
