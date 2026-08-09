/**
 * Unit tests for the pure query-param helpers (no network, no React).
 */
import { describe, expect, test } from "bun:test";
import { ROOT_PATH } from "../lib/tree-build.ts";
import { exactTreeLquery, normalizeSearchParams } from "./queries.ts";

describe("exactTreeLquery", () => {
  test("the empty path and the synthetic root bucket both pin to the root", () => {
    // `*{0,0}` matches an ltree of exactly zero labels — the empty tree.
    expect(exactTreeLquery("")).toBe("*{0,0}");
    expect(exactTreeLquery(ROOT_PATH)).toBe("*{0,0}");
  });

  test("a concrete path allows zero further labels (exact match)", () => {
    expect(exactTreeLquery("work")).toBe("work.*{0,0}");
    expect(exactTreeLquery("work.projects")).toBe("work.projects.*{0,0}");
    expect(exactTreeLquery("share.auth")).toBe("share.auth.*{0,0}");
  });

  test("the `~` home sugar stays a valid leading segment (TNT-248)", () => {
    // Regression: the old label-alternation form produced `~|~`, which is not
    // parseable as an lquery (the server expands `~` only as a LEADING
    // segment), so `memory.search` crashed with an Internal error whenever a
    // memory lived at the root of the caller's home.
    expect(exactTreeLquery("~")).toBe("~.*{0,0}");
    expect(exactTreeLquery("~.notes")).toBe("~.notes.*{0,0}");
  });

  test("never emits an lquery alternation, which `~` cannot express", () => {
    for (const path of ["", ROOT_PATH, "~", "~.a.b", "work", "share.auth"]) {
      expect(exactTreeLquery(path)).not.toContain("|");
    }
  });
});

describe("normalizeSearchParams", () => {
  test("preserves metaPredicate as a search criterion", () => {
    expect(normalizeSearchParams({ metaPredicate: "$.priority >= 3" })).toEqual(
      {
        metaPredicate: "$.priority >= 3",
        limit: 1000,
      },
    );
  });

  test("drops an empty metaPredicate and falls back to list-all", () => {
    expect(normalizeSearchParams({ metaPredicate: "" })).toEqual({
      tree: "*",
      limit: 1000,
    });
  });
});
