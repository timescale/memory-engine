/**
 * Tests for `me claude` helpers.
 *
 * The MCP/hook/settings shaping is covered by `claude/settings.test.ts` and the
 * shared `agent/*` tests; this file covers the outro recap re-exported here.
 */
import { describe, expect, test } from "bun:test";
import { initOutroLead } from "./claude.ts";

describe("initOutroLead", () => {
  const backfill = { kind: "backfill" } as const;
  const ongoing = { kind: "ongoing" } as const;
  const config = { kind: "config" } as const;

  test("backfill + ongoing → imported history and hooks keep it updated", () => {
    const lead = initOutroLead([backfill, ongoing, config]).join(" ");
    expect(lead).toContain("Imported");
    expect(lead).toContain("going forward");
  });

  test("backfill only → one-time import, no ongoing-capture claim", () => {
    const lead = initOutroLead([backfill, config]).join(" ");
    expect(lead).toContain("one-time");
    expect(lead).not.toContain("going forward");
  });

  test("ongoing only → capture hooks, no import claim", () => {
    const lead = initOutroLead([ongoing]).join(" ");
    expect(lead).toContain("going forward");
    expect(lead).not.toContain("Imported");
  });

  test("config only (or nothing) → no lead paragraph", () => {
    expect(initOutroLead([config])).toEqual([]);
    expect(initOutroLead([])).toEqual([]);
  });
});
