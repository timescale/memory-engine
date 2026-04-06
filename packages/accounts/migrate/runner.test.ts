import { describe, expect, test } from "bun:test";
import { getMigrations } from "./runner";

describe("getMigrations", () => {
  test("returns at least 1 migration", () => {
    expect(getMigrations().length).toBeGreaterThanOrEqual(1);
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

  test("contains bootstrap migration", () => {
    const names = getMigrations().map((m) => m.name);
    expect(names).toContain("001_create_schema");
  });
});
