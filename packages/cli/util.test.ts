/**
 * Unit tests for CLI utility helpers.
 *
 * Tests the space-model resolution functions with mocked clients.
 */
import { describe, expect, mock, test } from "bun:test";
import {
  type MemoryClient,
  RpcError,
  type UserClient,
} from "@memory.build/client";
import type { ResolvedCredentials } from "./credentials.ts";

// Dynamic import to avoid pulling in @clack/prompts at top level (it touches
// process.stdin).
const {
  resolveSpacePrincipalId,
  resolveSpaceMemberId,
  resolveAgentId,
  shellTildeExpansionHint,
  describeAuthError,
  describeForbiddenError,
} = await import("./util.ts");

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
// resolveSpaceMemberId
// =============================================================================

describe("resolveSpaceMemberId", () => {
  test("returns a UUIDv7 as-is without resolving", async () => {
    const memory = {
      principal: { resolve: mock(() => Promise.reject(new Error("unused"))) },
    } as unknown as MemoryClient;
    expect(await resolveSpaceMemberId(memory, UUID, "text")).toBe(UUID);
    expect(memory.principal.resolve).not.toHaveBeenCalled();
  });

  test("resolves a member name, filtering out a same-named group", async () => {
    // principal.resolve is name-scoped, not kind-scoped, so a shared name can
    // return both a member and a group; the member must win.
    const memory = {
      principal: {
        resolve: mock(() =>
          Promise.resolve({
            principals: [
              { id: UUID, kind: "u", name: "ops" },
              {
                id: "019d0000-0000-7000-8000-000000000000",
                kind: "g",
                name: "ops",
              },
            ],
          }),
        ),
      },
    } as unknown as MemoryClient;

    expect(await resolveSpaceMemberId(memory, "ops", "text")).toBe(UUID);
    // resolves by name only (no kind constraint); the filtering is client-side
    expect(memory.principal.resolve).toHaveBeenCalledWith({ name: "ops" });
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

// =============================================================================
// describeAuthError
// =============================================================================

const SERVER = "https://api.example.com";
const unauthorized = () =>
  new RpcError(-32000, "Invalid credentials", { code: "UNAUTHORIZED" });
const creds = (
  over: Partial<ResolvedCredentials> = {},
): ResolvedCredentials => ({
  server: SERVER,
  loggedIn: false,
  ...over,
});

describe("describeAuthError", () => {
  test("returns null for a non-UNAUTHORIZED error (falls back to raw message)", () => {
    const notFound = new RpcError(-32000, "Nope", { code: "NOT_FOUND" });
    expect(
      describeAuthError(notFound, creds({ apiKey: "me.k" }), "space"),
    ).toBeNull();
    expect(describeAuthError(new Error("boom"), creds(), "account")).toBeNull();
  });

  test("api key, account scope: blames the key, never clears a session", () => {
    const r = describeAuthError(
      unauthorized(),
      creds({ apiKey: "me.k", activeSpace: "abc123" }),
      "account",
    );
    expect(r).not.toBeNull();
    expect(r?.clearSession).toBe(false);
    expect(r?.message).toContain("ME_API_KEY");
    expect(r?.message).not.toContain("me login");
    // Account scope doesn't mention the space even when one is set.
    expect(r?.message).not.toContain("abc123");
  });

  test("api key, space scope: mentions the active space and 'me space list'", () => {
    const r = describeAuthError(
      unauthorized(),
      creds({ apiKey: "me.k", activeSpace: "abc123" }),
      "space",
    );
    expect(r?.clearSession).toBe(false);
    expect(r?.message).toContain("ME_API_KEY");
    expect(r?.message).toContain("'abc123'");
    expect(r?.message).toContain("me space list");
    expect(r?.message).not.toContain("me login");
  });

  test("session, account scope: genuine expiry — clears the token, prompts login", () => {
    const r = describeAuthError(
      unauthorized(),
      creds({ loggedIn: true }),
      "account",
    );
    expect(r?.clearSession).toBe(true);
    expect(r?.message).toBe(
      "Session expired. Run 'me login' to sign in again.",
    );
  });

  test("session, space scope: ambiguous — keeps the token, mentions space and login", () => {
    const r = describeAuthError(
      unauthorized(),
      creds({ loggedIn: true, activeSpace: "abc123" }),
      "space",
    );
    // Must NOT clear the session over what may just be a stale active space.
    expect(r?.clearSession).toBe(false);
    expect(r?.message).toContain("'abc123'");
    expect(r?.message).toContain("me space list");
    expect(r?.message).toContain("me login");
  });

  test("omits the slug when no active space is set", () => {
    const r = describeAuthError(
      unauthorized(),
      creds({ apiKey: "me.k" }),
      "space",
    );
    expect(r?.message).not.toContain("''");
    expect(r?.message).toContain("me space list");
  });
});

// =============================================================================
// describeForbiddenError
// =============================================================================

const forbidden = () =>
  new RpcError(-32000, "This action is user-only", { code: "FORBIDDEN" });

describe("describeForbiddenError", () => {
  test("account scope + act-as-agent explains how to run as the user", () => {
    const r = describeForbiddenError(
      forbidden(),
      creds({ asAgent: "my-agent" }),
      "account",
    );
    expect(r).toEqual({
      code: "FORBIDDEN",
      message:
        "Acting as agent 'my-agent'; this operation requires your user account. Unset ME_AS_AGENT or omit --as-agent to run it as your user account.",
    });
  });

  test("non-act-as or space denials fall back to the server message", () => {
    expect(describeForbiddenError(forbidden(), creds(), "account")).toBeNull();
    expect(
      describeForbiddenError(
        forbidden(),
        creds({ asAgent: "my-agent" }),
        "space",
      ),
    ).toBeNull();
  });
});
