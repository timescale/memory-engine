/**
 * Unit tests for CLI utility helpers.
 *
 * Tests the space-model resolution functions with mocked clients.
 */
import { describe, expect, mock, test } from "bun:test";
import type { MemoryClient, UserClient } from "@memory.build/client";

// Dynamic import to avoid pulling in @clack/prompts at top level (it touches
// process.stdin).
const { resolveSpacePrincipalId, resolveAgentId, shellTildeExpansionHint } =
  await import("./util.ts");

const UUID = "019d694f-79f6-7595-8faf-b70b01c11f98";

// =============================================================================
// resolveSpacePrincipalId
// =============================================================================

describe("resolveSpacePrincipalId", () => {
  test("returns a UUIDv7 as-is without resolving", async () => {
    const memory = {
      principal: { resolve: mock(() => Promise.reject(new Error("unused"))) },
    } as unknown as MemoryClient;
    expect(await resolveSpacePrincipalId(memory, UUID, "text")).toBe(UUID);
    expect(memory.principal.resolve).not.toHaveBeenCalled();
  });

  test("resolves a name via principal.resolve (with optional kind)", async () => {
    const memory = {
      principal: {
        resolve: mock(() =>
          Promise.resolve({
            principals: [{ id: UUID, kind: "g", name: "eng" }],
          }),
        ),
      },
    } as unknown as MemoryClient;

    const id = await resolveSpacePrincipalId(memory, "eng", "text", "g");
    expect(id).toBe(UUID);
    expect(memory.principal.resolve).toHaveBeenCalledWith({
      name: "eng",
      kind: "g",
    });
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

// =============================================================================
// shellTildeExpansionHint
// =============================================================================

const HOME = "/Users/me";
// argv is [exec, script, ...userArgs]; the helper reads user args from index 2.
const argv = (...userArgs: string[]) => ["bun", "me", ...userArgs];

describe("shellTildeExpansionHint", () => {
  test("rebuilds the full command, quoting the shell-expanded ~ token", () => {
    // `me export --tree ~/granola ~/Downloads/granola.bak` — the shell expands
    // both `~`s; only the tree token is the mistake, so only it gets requoted.
    expect(
      shellTildeExpansionHint(
        `${HOME}/granola`,
        argv(
          "export",
          "--tree",
          `${HOME}/granola`,
          `${HOME}/Downloads/granola.bak`,
        ),
        HOME,
      ),
    ).toBe(
      "Hint: your shell may have expanded '~'. Try: me export --tree '~/granola' /Users/me/Downloads/granola.bak",
    );
  });

  test("bare ~ (home itself) suggests '~'", () => {
    expect(shellTildeExpansionHint(HOME, argv("count", HOME), HOME)).toBe(
      "Hint: your shell may have expanded '~'. Try: me count '~'",
    );
  });

  test("quotes other args that need it (e.g. a query with spaces)", () => {
    expect(
      shellTildeExpansionHint(
        `${HOME}/notes`,
        argv("search", "foo bar", "--tree", `${HOME}/notes`),
        HOME,
      ),
    ).toBe(
      "Hint: your shell may have expanded '~'. Try: me search 'foo bar' --tree '~/notes'",
    );
  });

  test("returns null for a real tree filter", () => {
    expect(
      shellTildeExpansionHint(
        "share/notes",
        argv("search", "--tree", "share/notes"),
        HOME,
      ),
    ).toBeNull();
    // An already-quoted `~/granola` reaches us literally — not a home path.
    expect(
      shellTildeExpansionHint(
        "~/granola",
        argv("search", "--tree", "~/granola"),
        HOME,
      ),
    ).toBeNull();
  });

  test("does not match a sibling that merely shares the home prefix", () => {
    // `/Users/menagerie` is not under `/Users/me`.
    expect(
      shellTildeExpansionHint(
        "/Users/menagerie",
        argv("tree", "/Users/menagerie"),
        HOME,
      ),
    ).toBeNull();
  });

  test("returns null for empty input or a pathological '/' home", () => {
    expect(shellTildeExpansionHint(undefined, argv("tree"), HOME)).toBeNull();
    expect(shellTildeExpansionHint("", argv("tree", ""), HOME)).toBeNull();
    expect(
      shellTildeExpansionHint("/anything", argv("tree", "/anything"), "/"),
    ).toBeNull();
  });
});
