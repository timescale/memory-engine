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
