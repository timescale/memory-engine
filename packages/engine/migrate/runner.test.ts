import { describe, expect, test } from "bun:test";
import { getMigrations } from "./runner";

describe("getMigrations", () => {
  test("returns 4 migrations", () => {
    expect(getMigrations()).toHaveLength(4);
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

  test("contains expected migration names", () => {
    const names = getMigrations().map((m) => m.name);
    expect(names).toContain("001_updated_at");
    expect(names).toContain("002_memory");
    expect(names).toContain("003_memory_trigger");
    expect(names).toContain("004_auth_tables");
  });
});
