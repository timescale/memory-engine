import { describe, expect, test } from "bun:test";
import {
  EMPTY_ADVANCED,
  EMPTY_FILTER,
  type FilterState,
  summarizeFilter,
} from "./filter.ts";

function withSimple(q: string): FilterState {
  return { ...EMPTY_FILTER, mode: "simple", simple: q };
}

function withAdvanced(patch: Partial<typeof EMPTY_ADVANCED>): FilterState {
  return {
    ...EMPTY_FILTER,
    mode: "advanced",
    advanced: { ...EMPTY_ADVANCED, ...patch },
  };
}

describe("summarizeFilter (simple mode)", () => {
  test("empty simple returns no chips and hasFilter=false", () => {
    expect(summarizeFilter(EMPTY_FILTER)).toEqual({
      chips: [],
      hasFilter: false,
    });
  });

  test("whitespace-only simple is treated as empty", () => {
    expect(summarizeFilter(withSimple("   "))).toEqual({
      chips: [],
      hasFilter: false,
    });
  });

  test("non-empty simple emits a single quoted query chip", () => {
    const { chips, hasFilter } = summarizeFilter(withSimple("typescript"));
    expect(chips).toEqual([`query: "typescript"`]);
    expect(hasFilter).toBe(true);
  });

  test("long simple query is truncated in the chip", () => {
    const long = "a".repeat(100);
    const { chips } = summarizeFilter(withSimple(long));
    expect(chips[0]).toMatch(/^query: "a+…"$/);
    expect(chips[0]?.length).toBeLessThan(80);
  });
});

describe("summarizeFilter (advanced mode)", () => {
  test("empty advanced returns no chips", () => {
    expect(summarizeFilter(withAdvanced({}))).toEqual({
      chips: [],
      hasFilter: false,
    });
  });

  test("each scalar field produces its own chip", () => {
    const { chips } = summarizeFilter(
      withAdvanced({
        semantic: "hello",
        fulltext: "world",
        grep: "^foo",
        tree: "work.*",
        limit: "50",
        candidateLimit: "25",
        orderBy: "asc",
      }),
    );
    expect(chips).toEqual([
      `semantic: "hello"`,
      `fulltext: "world"`,
      `grep: /^foo/`,
      `tree: work.*`,
      `limit: 50`,
      `candidateLimit: 25`,
      `order: asc`,
    ]);
  });

  test("meta JSON: valid object shows key preview", () => {
    const { chips } = summarizeFilter(
      withAdvanced({ metaJson: '{"a":1,"b":2}' }),
    );
    expect(chips).toEqual(["meta: {a, b}"]);
  });

  test("meta JSON: empty object renders as '{}'", () => {
    const { chips } = summarizeFilter(withAdvanced({ metaJson: "{}" }));
    expect(chips).toEqual(["meta: {}"]);
  });

  test("meta JSON: >3 keys truncates with ellipsis", () => {
    const { chips } = summarizeFilter(
      withAdvanced({ metaJson: '{"a":1,"b":2,"c":3,"d":4,"e":5}' }),
    );
    expect(chips).toEqual(["meta: {a, b, c, …}"]);
  });

  test("meta JSON: invalid JSON renders as invalid", () => {
    const { chips } = summarizeFilter(withAdvanced({ metaJson: "{nope" }));
    expect(chips).toEqual(["meta: (invalid JSON)"]);
  });

  test("meta JSON: array or non-object renders as (not an object)", () => {
    expect(summarizeFilter(withAdvanced({ metaJson: "[1,2]" })).chips).toEqual([
      "meta: (not an object)",
    ]);
    expect(summarizeFilter(withAdvanced({ metaJson: '"x"' })).chips).toEqual([
      "meta: (not an object)",
    ]);
  });

  test("temporal: contains with only start renders a contains chip", () => {
    const { chips } = summarizeFilter(
      withAdvanced({
        temporal: { mode: "contains", start: "2026-01-01T00:00", end: "" },
      }),
    );
    expect(chips).toEqual(["temporal contains 2026-01-01T00:00"]);
  });

  test("temporal: overlaps/within requires both endpoints", () => {
    const overlaps = summarizeFilter(
      withAdvanced({
        temporal: {
          mode: "overlaps",
          start: "2026-01-01",
          end: "2026-02-01",
        },
      }),
    );
    expect(overlaps.chips).toEqual([
      "temporal overlaps [2026-01-01 → 2026-02-01]",
    ]);

    const missingEnd = summarizeFilter(
      withAdvanced({
        temporal: { mode: "within", start: "2026-01-01", end: "" },
      }),
    );
    expect(missingEnd.chips).toEqual([]);
  });

  test("weights: either side alone is summarized", () => {
    expect(
      summarizeFilter(withAdvanced({ weightsSemantic: "0.7" })).chips,
    ).toEqual(["weights: sem=0.7"]);
    expect(
      summarizeFilter(
        withAdvanced({ weightsSemantic: "0.7", weightsFulltext: "0.3" }),
      ).chips,
    ).toEqual(["weights: sem=0.7, full=0.3"]);
  });
});
