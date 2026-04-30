import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addEngineApiKey,
  getEngineApiKey,
  getServerCredentials,
  parseEngineSlugFromKey,
  storeApiKey,
} from "./credentials.ts";

describe("parseEngineSlugFromKey", () => {
  test("parses slug from a well-formed key", () => {
    expect(parseEngineSlugFromKey("me.team-foo.k1.s1")).toBe("team-foo");
  });

  test("returns undefined when prefix is wrong", () => {
    expect(parseEngineSlugFromKey("xx.team-foo.k1.s1")).toBeUndefined();
  });

  test("returns undefined when too few parts", () => {
    expect(parseEngineSlugFromKey("me.team-foo.k1")).toBeUndefined();
    expect(parseEngineSlugFromKey("me")).toBeUndefined();
    expect(parseEngineSlugFromKey("")).toBeUndefined();
  });

  test("accepts extra parts (treats them as part of the secret)", () => {
    expect(parseEngineSlugFromKey("me.team-foo.k1.s1.extra")).toBe("team-foo");
  });
});

describe("addEngineApiKey", () => {
  const SERVER = "https://api.memory.build";
  let tmpHome: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "me-creds-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpHome;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("persists the API key under engines.<slug>.api_key", () => {
    addEngineApiKey(SERVER, "team-foo", "me.team-foo.k1.s1");
    expect(getEngineApiKey(SERVER, "team-foo")).toBe("me.team-foo.k1.s1");
  });

  test("does NOT mutate active_engine", () => {
    storeApiKey(SERVER, "personal-gonzalo", "me.personal-gonzalo.k0.s0");
    expect(getServerCredentials(SERVER).active_engine).toBe("personal-gonzalo");

    addEngineApiKey(SERVER, "team-foo", "me.team-foo.k1.s1");

    expect(getServerCredentials(SERVER).active_engine).toBe("personal-gonzalo");
    expect(getEngineApiKey(SERVER, "team-foo")).toBe("me.team-foo.k1.s1");
  });

  test("overwrites an existing key for the same slug", () => {
    addEngineApiKey(SERVER, "team-foo", "me.team-foo.k1.s1");
    addEngineApiKey(SERVER, "team-foo", "me.team-foo.k2.s2");
    expect(getEngineApiKey(SERVER, "team-foo")).toBe("me.team-foo.k2.s2");
  });
});
