import { describe, expect, test } from "bun:test";
import type { EngineInfo } from "../commands/engine.ts";
import { resolveEngineForSession } from "./engine-resolve.ts";

const mkEngine = (overrides: Partial<EngineInfo>): EngineInfo => ({
  id: "01000000-0000-7000-8000-000000000000",
  slug: "engine-1",
  name: "Engine One",
  status: "active",
  orgId: "01000000-0000-7000-8000-00000000a000",
  orgSlug: "tigerdata",
  orgName: "Tiger Data",
  ...overrides,
});

const engines: EngineInfo[] = [
  mkEngine({ slug: "team-oncall", name: "Team On-call" }),
  mkEngine({
    slug: "personal-gonzalo",
    name: "Personal",
    orgSlug: "personal",
    orgName: "Personal",
    orgId: "01000000-0000-7000-8000-00000000b000",
  }),
  mkEngine({
    slug: "oncall",
    name: "Other On-call",
    orgSlug: "other",
    orgName: "Other Co",
    orgId: "01000000-0000-7000-8000-00000000c000",
  }),
];

describe("resolveEngineForSession", () => {
  test("exact slug match returns the engine", () => {
    const result = resolveEngineForSession(engines, "team-oncall", undefined);
    expect(result.slug).toBe("team-oncall");
  });

  test("exact name match returns the engine", () => {
    const result = resolveEngineForSession(engines, "Personal", undefined);
    expect(result.slug).toBe("personal-gonzalo");
  });

  test("ambiguous exact match across orgs throws with disambiguator hint", () => {
    const ambiguous: EngineInfo[] = [
      mkEngine({ slug: "oncall", orgSlug: "a" }),
      mkEngine({ slug: "oncall", orgSlug: "b" }),
    ];
    expect(() =>
      resolveEngineForSession(ambiguous, "oncall", undefined),
    ).toThrow(/Ambiguous engine 'oncall'.*a:oncall.*b:oncall/);
  });

  test("org scope narrows ambiguous match to one", () => {
    const ambiguous: EngineInfo[] = [
      mkEngine({ slug: "oncall", orgSlug: "a" }),
      mkEngine({ slug: "oncall", orgSlug: "b" }),
    ];
    const result = resolveEngineForSession(ambiguous, "oncall", "a");
    expect(result.orgSlug).toBe("a");
  });

  test("org scope filters by orgName as well as orgSlug", () => {
    const result = resolveEngineForSession(engines, "oncall", "Other Co");
    expect(result.slug).toBe("oncall");
  });

  test("fuzzy substring match returns single result", () => {
    const result = resolveEngineForSession(engines, "gonzalo", undefined);
    expect(result.slug).toBe("personal-gonzalo");
  });

  test("fuzzy match throws when multiple engines match", () => {
    expect(() => resolveEngineForSession(engines, "on", undefined)).toThrow(
      /matches multiple engines/,
    );
  });

  test("no match throws with engine_list hint", () => {
    expect(() =>
      resolveEngineForSession(engines, "does-not-exist", undefined),
    ).toThrow(/No engine matches 'does-not-exist'.*me_engine_list/);
  });

  test("no match in org scope mentions the org", () => {
    expect(() =>
      resolveEngineForSession(engines, "team-oncall", "personal"),
    ).toThrow(/No engine matches 'team-oncall' in org 'personal'/);
  });

  test("exact match takes precedence over fuzzy match", () => {
    const overlapping: EngineInfo[] = [
      mkEngine({ slug: "oncall-team", name: "Oncall Team" }),
      mkEngine({ slug: "oncall", name: "Oncall" }),
    ];
    const result = resolveEngineForSession(overlapping, "oncall", undefined);
    expect(result.slug).toBe("oncall");
  });
});
