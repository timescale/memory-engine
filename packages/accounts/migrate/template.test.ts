import { describe, expect, test } from "bun:test";
import { defaultConfig, resolveConfig, template } from "./template";

describe("template function", () => {
  test("replaces single variable", () => {
    const sql = "CREATE TABLE {{schema}}.foo (id uuid)";
    const result = template(sql, { schema: "accounts" });
    expect(result).toBe("CREATE TABLE accounts.foo (id uuid)");
  });

  test("replaces same variable multiple times", () => {
    const sql = "{{schema}}.a and {{schema}}.b";
    const result = template(sql, { schema: "test" });
    expect(result).toBe("test.a and test.b");
  });

  test("throws on missing variable", () => {
    const sql = "CREATE TABLE {{missing}}.foo";
    expect(() => template(sql, {})).toThrow(
      "Missing template variable: missing",
    );
  });

  test("handles no variables", () => {
    const sql = "CREATE TABLE foo (id uuid)";
    const result = template(sql, {});
    expect(result).toBe("CREATE TABLE foo (id uuid)");
  });

  test("handles numeric values", () => {
    const sql = "LIMIT {{limit}}";
    const result = template(sql, { limit: 100 });
    expect(result).toBe("LIMIT 100");
  });
});

describe("config", () => {
  test("defaultConfig has schema = accounts", () => {
    expect(defaultConfig.schema).toBe("accounts");
  });

  test("resolveConfig uses default schema", () => {
    const resolved = resolveConfig();
    expect(resolved.schema).toBe("accounts");
  });

  test("resolveConfig allows schema override", () => {
    const resolved = resolveConfig({ schema: "accounts_test" });
    expect(resolved.schema).toBe("accounts_test");
  });
});
