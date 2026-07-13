// Unit tests for pure helpers in the memory data-plane handlers (no DB).
import { describe, expect, test } from "bun:test";
import { dedupeOwnHome } from "./memory";

type Entry = { tree: string; count: number };

describe("dedupeOwnHome", () => {
  // A user's home is `home.<id>`; its only strict ancestor is the bare `home`.
  const USER = "home.abc";

  test("subtracts the caller's own home from the bare `home` ancestor", () => {
    // 2 memories under the caller's home, 1 under another member's home.
    const entries: Entry[] = [
      { tree: "home", count: 3 }, // 2 own + 1 other
      { tree: "home.abc", count: 2 }, // ~ (own)
      { tree: "home.abc.a", count: 1 },
      { tree: "home.abc.b", count: 1 },
      { tree: "home.xyz", count: 1 }, // another member's home
      { tree: "home.xyz.k", count: 1 },
    ];
    const result = dedupeOwnHome(entries, USER);
    const byTree = Object.fromEntries(result.map((e) => [e.tree, e.count]));
    // `home` now reflects only the other member's home.
    expect(byTree.home).toBe(1);
    // The caller's own home and every other entry are untouched.
    expect(byTree["home.abc"]).toBe(2);
    expect(byTree["home.abc.a"]).toBe(1);
    expect(byTree["home.xyz"]).toBe(1);
  });

  test("drops the `home` ancestor when the caller has no other-home access", () => {
    const entries: Entry[] = [
      { tree: "home", count: 2 }, // entirely the caller's own
      { tree: "home.abc", count: 2 },
      { tree: "home.abc.a", count: 1 },
      { tree: "home.abc.b", count: 1 },
    ];
    const result = dedupeOwnHome(entries, USER);
    // The literal `home` root disappears; `~` (home.abc) still carries it all.
    expect(result.some((e) => e.tree === "home")).toBe(false);
    expect(result.find((e) => e.tree === "home.abc")?.count).toBe(2);
  });

  test("agent home strips both `home` and the owner-home ancestor", () => {
    // An agent's home nests under its owner's: `home.<owner>.<agent>`.
    const AGENT = "home.own.ag";
    const entries: Entry[] = [
      { tree: "home", count: 5 }, // 2 agent + 3 owner/others
      { tree: "home.own", count: 4 }, // 2 agent + 2 owner-direct
      { tree: "home.own.ag", count: 2 }, // ~ (agent's own)
      { tree: "home.own.ag.x", count: 2 },
      { tree: "home.own.notes", count: 2 }, // owner's own memories
    ];
    const result = dedupeOwnHome(entries, AGENT);
    const byTree = Object.fromEntries(result.map((e) => [e.tree, e.count]));
    expect(byTree.home).toBe(3); // 5 - 2
    expect(byTree["home.own"]).toBe(2); // 4 - 2 (owner's non-agent memories)
    expect(byTree["home.own.ag"]).toBe(2); // untouched (this is `~`)
    expect(byTree["home.own.notes"]).toBe(2); // untouched
  });

  test("no-op when the caller has no home memories", () => {
    const entries: Entry[] = [
      { tree: "home", count: 1 }, // another member's home only
      { tree: "home.xyz", count: 1 },
      { tree: "share", count: 4 },
    ];
    const result = dedupeOwnHome(entries, USER);
    expect(result).toEqual(entries);
  });

  test("no-op for a caller with no home (null prefix)", () => {
    const entries: Entry[] = [
      { tree: "home", count: 1 },
      { tree: "home.xyz", count: 1 },
    ];
    expect(dedupeOwnHome(entries, null)).toEqual(entries);
  });
});
