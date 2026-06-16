/**
 * Tests for `me claude` helpers.
 */
import { describe, expect, test } from "bun:test";
import { initOutroLead, pluginListShowsInstalled } from "./claude.ts";

describe("pluginListShowsInstalled", () => {
  test("finds the plugin by its id in `claude plugin list --json` output", () => {
    const out = JSON.stringify([
      { id: "superpowers@superpowers-marketplace", enabled: true },
      { id: "memory-engine@memory-engine", version: "0.1.0", enabled: true },
    ]);
    expect(pluginListShowsInstalled(out)).toBe(true);
  });

  test("a disabled install still counts as installed", () => {
    const out = JSON.stringify([
      { id: "memory-engine@memory-engine", enabled: false },
    ]);
    expect(pluginListShowsInstalled(out)).toBe(true);
  });

  test("other plugins do not match", () => {
    const out = JSON.stringify([
      { id: "memory-engine-fork@somewhere", enabled: true },
    ]);
    expect(pluginListShowsInstalled(out)).toBe(false);
  });

  test("empty list and unparseable output count as not installed", () => {
    expect(pluginListShowsInstalled("[]")).toBe(false);
    expect(pluginListShowsInstalled("")).toBe(false);
    expect(pluginListShowsInstalled("Installed plugins:\n  ❯ …")).toBe(false);
    expect(pluginListShowsInstalled('{"not": "an array"}')).toBe(false);
  });
});

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
