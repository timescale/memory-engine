/**
 * Tests for `me claude` helpers.
 */
import { describe, expect, test } from "bun:test";
import { initOutroLead } from "../agent/init.ts";
import {
  buildPluginConfig,
  type PluginConfigDecision,
  pluginListShowsInstalled,
} from "./claude.ts";

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

describe("buildPluginConfig", () => {
  // A logged-in session with an active space, no api key — the common personal case.
  const SESSION = {
    server: "https://api.memory.build",
    activeSpace: "spc",
    apiKey: undefined,
    loggedIn: true,
  };

  function cfg(d: PluginConfigDecision): string[] {
    if ("error" in d) throw new Error(`expected config, got error: ${d.error}`);
    return d.config;
  }

  // --- session (personal) install: pin nothing by default ---

  test("session, no flags → pins nothing (tracks live CLI config)", () => {
    const d = buildPluginConfig({}, SESSION);
    expect(cfg(d)).toEqual([]);
    expect("warn" in d && d.warn).toBeFalsy();
  });

  test("session, no active space → warns but still pins nothing", () => {
    const d = buildPluginConfig({}, { ...SESSION, activeSpace: undefined });
    expect(cfg(d)).toEqual([]);
    if ("error" in d) throw new Error("unexpected error");
    expect(d.warn).toContain("No active space");
  });

  test("session, --server pins only server", () => {
    expect(cfg(buildPluginConfig({ server: "https://dev" }, SESSION))).toEqual([
      "--config",
      "server=https://dev",
    ]);
  });

  test("session, --space pins only space", () => {
    expect(cfg(buildPluginConfig({ space: "x" }, SESSION))).toEqual([
      "--config",
      "space=x",
    ]);
  });

  test("session, not logged in + no key → error", () => {
    const d = buildPluginConfig({}, { ...SESSION, loggedIn: false });
    expect("error" in d && d.error).toContain("Not logged in");
  });

  // --- headless (api key) install: bake in a self-contained config ---

  test("--api-key → bakes in server + space + key from resolved config", () => {
    expect(cfg(buildPluginConfig({ apiKey: "k" }, SESSION))).toEqual([
      "--config",
      "server=https://api.memory.build",
      "--config",
      "space=spc",
      "--config",
      "api_key=k",
    ]);
  });

  test("ME_API_KEY (creds.apiKey) also triggers headless pinning", () => {
    expect(
      cfg(buildPluginConfig({}, { ...SESSION, apiKey: "envkey" })),
    ).toEqual([
      "--config",
      "server=https://api.memory.build",
      "--config",
      "space=spc",
      "--config",
      "api_key=envkey",
    ]);
  });

  test("explicit --server/--space override the resolved values", () => {
    expect(
      cfg(
        buildPluginConfig(
          { server: "https://dev", space: "d", apiKey: "k" },
          SESSION,
        ),
      ),
    ).toEqual([
      "--config",
      "server=https://dev",
      "--config",
      "space=d",
      "--config",
      "api_key=k",
    ]);
  });

  test("api key but no space anywhere → error (keys are global)", () => {
    const d = buildPluginConfig(
      { apiKey: "k" },
      { ...SESSION, activeSpace: undefined },
    );
    expect("error" in d && d.error).toContain("No space for the API key");
  });
});
