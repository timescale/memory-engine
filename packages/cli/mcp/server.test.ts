import { describe, expect, test } from "bun:test";
import type { MemoryNamespace } from "../client.ts";
import { RpcError } from "../client.ts";
import { wrapMemoryForSpaceHints } from "./server.ts";
import type { ListedSpace } from "./space.ts";

// A wrong-space failure on a tool call must be rewritten into a helpful,
// agent-visible message; everything else must pass through unchanged. The proxy
// only needs a couple of real methods, so stub the namespace and cast.
function stubMemory(impl: Partial<MemoryNamespace>): MemoryNamespace {
  return impl as MemoryNamespace;
}

const spaces: ListedSpace[] = [{ slug: "abc123def456", name: "default" }];

describe("wrapMemoryForSpaceHints", () => {
  test("passes successful calls through untouched", async () => {
    const sentinel = { results: [], total: 0, limit: 10 };
    const memory = stubMemory({
      search: (async () => sentinel) as MemoryNamespace["search"],
    });
    const wrapped = wrapMemoryForSpaceHints(memory, "default", async () => {
      throw new Error("probe should not run on success");
    });
    const out = (await wrapped.search({})) as unknown;
    expect(out).toBe(sentinel);
  });

  test("rewrites a space-shaped error into a slug hint", async () => {
    const memory = stubMemory({
      search: async () => {
        throw new RpcError(
          "UNAUTHORIZED" as unknown as number,
          "Invalid credentials",
        );
      },
    });
    const wrapped = wrapMemoryForSpaceHints(
      memory,
      "default",
      async () => spaces,
    );
    await expect(wrapped.search({})).rejects.toThrow(
      "Space 'default' is a display name, not a slug. Did you mean 'abc123def456'?",
    );
  });

  test("preserves the original error when the space is actually valid", async () => {
    const memory = stubMemory({
      search: async () => {
        throw new RpcError(
          "FORBIDDEN" as unknown as number,
          "No access to this space",
        );
      },
    });
    const wrapped = wrapMemoryForSpaceHints(
      memory,
      "abc123def456",
      async () => spaces,
    );
    await expect(wrapped.search({})).rejects.toThrow("No access to this space");
  });

  test("preserves a non-space error without probing", async () => {
    let probed = false;
    const memory = stubMemory({
      get: async () => {
        throw new RpcError(-32000, "not found", { code: "NOT_FOUND" });
      },
    });
    const wrapped = wrapMemoryForSpaceHints(memory, "default", async () => {
      probed = true;
      return spaces;
    });
    await expect(wrapped.get({ id: "x" })).rejects.toThrow("not found");
    expect(probed).toBe(false);
  });
});
