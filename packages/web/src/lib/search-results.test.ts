import { describe, expect, test } from "bun:test";
import { EMPTY_ADVANCED, type FilterState } from "../store/filter.ts";
import {
  autoSelectTarget,
  buildTextMatchers,
  contentFragment,
  fragmentSegments,
  type TextMatchers,
} from "./search-results.ts";

function matchers(terms: string[], regex: RegExp | null = null): TextMatchers {
  return { terms, regex };
}

describe("fragmentSegments", () => {
  test("no matchers → single unmatched segment", () => {
    expect(fragmentSegments("plain text", matchers([]))).toEqual([
      { text: "plain text", match: false },
    ]);
  });

  test("term matches are case-insensitive and repeat", () => {
    expect(fragmentSegments("Auth and auth again", matchers(["auth"]))).toEqual(
      [
        { text: "Auth", match: true },
        { text: " and ", match: false },
        { text: "auth", match: true },
        { text: " again", match: false },
      ],
    );
  });

  test("overlapping and adjacent ranges merge", () => {
    // "token" and "tokens" overlap; "s " boundary stays unmatched.
    expect(
      fragmentSegments("refresh tokens", matchers(["token", "tokens"])),
    ).toEqual([
      { text: "refresh ", match: false },
      { text: "tokens", match: true },
    ]);
  });

  test("match at start and end of fragment", () => {
    expect(fragmentSegments("auth flow auth", matchers(["auth"]))).toEqual([
      { text: "auth", match: true },
      { text: " flow ", match: false },
      { text: "auth", match: true },
    ]);
  });

  test("grep regex matches are applied globally", () => {
    expect(
      fragmentSegments("me.abc.def and me.xyz.123", matchers([], /me\.\w+/i)),
    ).toEqual([
      { text: "me.abc", match: true },
      { text: ".def and ", match: false },
      { text: "me.xyz", match: true },
      { text: ".123", match: false },
    ]);
  });

  test("zero-width regex matches don't loop forever", () => {
    expect(fragmentSegments("abc", matchers([], /x*/i))).toEqual([
      { text: "abc", match: false },
    ]);
  });

  test("terms and regex combine", () => {
    expect(
      fragmentSegments("key me.abc key", matchers(["key"], /me\.\w+/i)),
    ).toEqual([
      { text: "key", match: true },
      { text: " ", match: false },
      { text: "me.abc", match: true },
      { text: " ", match: false },
      { text: "key", match: true },
    ]);
  });
});

describe("autoSelectTarget", () => {
  // Deliberately unsorted: relevance order is c (0.9), a (0.5), b (0.1).
  const results = [
    { id: "a", score: 0.5, createdAt: "2026-01-02" },
    { id: "b", score: 0.1, createdAt: "2026-01-03" },
    { id: "c", score: 0.9, createdAt: "2026-01-01" },
  ];
  const base = {
    results,
    selectedId: null,
    selectedVia: "user" as const,
    editorDirty: false,
    filterChanged: true,
  };

  test("no selection → picks the top result by relevance", () => {
    expect(autoSelectTarget(base)).toBe("c");
  });

  test("equal scores tie-break on newest createdAt", () => {
    const tied = results.map((r) => ({ ...r, score: 1 }));
    expect(autoSelectTarget({ ...base, results: tied })).toBe("b");
  });

  test("empty results → leaves selection alone", () => {
    expect(autoSelectTarget({ ...base, results: [] })).toBeNull();
  });

  test("changed query re-selects the top even when the selection matches", () => {
    expect(autoSelectTarget({ ...base, selectedId: "a" })).toBe("c");
  });

  test("top result already selected → no redundant select", () => {
    expect(autoSelectTarget({ ...base, selectedId: "c" })).toBeNull();
  });

  test("same-query refetch keeps a still-matching selection", () => {
    expect(
      autoSelectTarget({ ...base, selectedId: "a", filterChanged: false }),
    ).toBeNull();
  });

  test("same-query refetch replaces a selection that dropped out", () => {
    expect(
      autoSelectTarget({ ...base, selectedId: "gone", filterChanged: false }),
    ).toBe("c");
  });

  test("shared-link selection is never stolen", () => {
    expect(
      autoSelectTarget({ ...base, selectedId: "gone", selectedVia: "link" }),
    ).toBeNull();
    expect(
      autoSelectTarget({ ...base, selectedId: "a", selectedVia: "link" }),
    ).toBeNull();
  });

  test("dirty editor blocks auto-select", () => {
    expect(autoSelectTarget({ ...base, editorDirty: true })).toBeNull();
    expect(
      autoSelectTarget({ ...base, selectedId: "gone", editorDirty: true }),
    ).toBeNull();
  });
});

describe("contentFragment + buildTextMatchers round-trip", () => {
  test("fragment windows around the first match and segments highlight it", () => {
    const filter: FilterState = {
      mode: "simple",
      simple: "needle",
      advanced: EMPTY_ADVANCED,
    };
    const m = buildTextMatchers(filter);
    const content = `${"x".repeat(500)} the needle is here ${"y".repeat(500)}`;
    const fragment = contentFragment(content, m);
    expect(fragment).toContain("needle");
    const segments = fragmentSegments(fragment, m);
    expect(segments.some((s) => s.match && s.text === "needle")).toBe(true);
  });
});
