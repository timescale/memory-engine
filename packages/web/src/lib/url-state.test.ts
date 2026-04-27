/**
 * Tests for URL ↔ filter state encode/decode.
 *
 * These are pure function tests — no React, no browser APIs beyond
 * URLSearchParams (which exists in both Bun and browsers).
 */
import { describe, expect, test } from "bun:test";
import { EMPTY_FILTER, type FilterState } from "../store/filter.ts";
import { decodeUrlState, encodeUrlState } from "./url-state.ts";

describe("encode/decode round-trip", () => {
  test("empty filter with no selection yields an empty query string", () => {
    expect(encodeUrlState(EMPTY_FILTER, null)).toBe("");
  });

  test("simple query round-trips", () => {
    const filter: FilterState = {
      ...EMPTY_FILTER,
      mode: "simple",
      simple: "TypeScript release",
    };
    const qs = encodeUrlState(filter, "01234567-89ab-7cde-8fab-0123456789ab");
    expect(qs).toContain("q=TypeScript+release");
    expect(qs).toContain("selected=");
    const round = decodeUrlState(qs);
    expect(round.filter.mode).toBe("simple");
    expect(round.filter.simple).toBe("TypeScript release");
    expect(round.selectedId).toBe("01234567-89ab-7cde-8fab-0123456789ab");
  });

  test("advanced filter round-trips each field", () => {
    const filter: FilterState = {
      mode: "advanced",
      simple: "",
      advanced: {
        semantic: "vector query",
        fulltext: "keyword query",
        grep: "[a-z]+",
        tree: "work.*",
        metaJson: '{"priority":"high"}',
        temporal: {
          mode: "within",
          start: "2026-01-01T00:00:00Z",
          end: "2026-12-31T23:59:59Z",
        },
        limit: "500",
        candidateLimit: "200",
        semanticThreshold: "0.72",
        weightsSemantic: "0.7",
        weightsFulltext: "0.3",
        orderBy: "desc",
      },
    };
    const qs = encodeUrlState(filter, null);
    const round = decodeUrlState(qs);
    expect(round.filter).toEqual(filter);
  });

  test("mode flag is only emitted when advanced", () => {
    const simple: FilterState = {
      ...EMPTY_FILTER,
      simple: "hello",
    };
    const qs = encodeUrlState(simple, null);
    expect(qs).not.toContain("mode=");
  });

  test("unknown params are ignored", () => {
    const round = decodeUrlState("?unknown=x&q=hi");
    expect(round.filter.simple).toBe("hi");
    expect(round.selectedId).toBeNull();
  });
});
