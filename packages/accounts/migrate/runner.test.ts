import { describe, expect, test } from "bun:test";
import { getMigrations } from "./runner";

describe("getMigrations", () => {
  test("returns an array", () => {
    expect(Array.isArray(getMigrations())).toBe(true);
  });

  test("migrations are sorted by name", () => {
    const names = getMigrations().map((m) => m.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  test("migration names match NNN_name pattern", () => {
    for (const { name } of getMigrations()) {
      expect(name).toMatch(/^\d{3}_\w+$/);
    }
  });

  // Note: scaffold() handles infrastructure (schema, version, migration tables)
  // Domain migrations will be added to the migrations array as needed
});
