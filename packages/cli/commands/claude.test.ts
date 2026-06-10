/**
 * Tests for `me claude` helpers.
 */
import { describe, expect, test } from "bun:test";
import { pluginListShowsInstalled } from "./claude.ts";

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
