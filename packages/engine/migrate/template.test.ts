import { describe, expect, test } from "bun:test";
import { defaultConfig, resolveConfig, template } from "./template";

describe("template function", () => {
  test("replaces single variable", () => {
    const sql = "CREATE TABLE foo (id {{type}})";
    const result = template(sql, { type: "UUID" });
    expect(result).toBe("CREATE TABLE foo (id UUID)");
  });

  test("replaces multiple variables", () => {
    const sql = "CREATE INDEX ON table USING {{method}} WITH (m = {{m}})";
    const result = template(sql, { method: "hnsw", m: 16 });
    expect(result).toBe("CREATE INDEX ON table USING hnsw WITH (m = 16)");
  });

  test("replaces same variable multiple times", () => {
    const sql = "{{var}} and {{var}} and {{var}}";
    const result = template(sql, { var: "test" });
    expect(result).toBe("test and test and test");
  });

  test("throws on missing variable", () => {
    const sql = "CREATE TABLE foo (x {{missing}})";
    expect(() => template(sql, {})).toThrow(
      "Missing template variable: missing",
    );
  });

  test("handles numeric values", () => {
    const sql = "WITH (m = {{value}})";
    const result = template(sql, { value: 1536 });
    expect(result).toBe("WITH (m = 1536)");
  });

  test("handles decimal values", () => {
    const sql = "WITH (k1 = {{k1}}, b = {{b}})";
    const result = template(sql, { k1: 1.2, b: 0.75 });
    expect(result).toBe("WITH (k1 = 1.2, b = 0.75)");
  });

  test("handles boolean values", () => {
    const sql = "SET enabled = {{enabled}}";
    const result = template(sql, { enabled: true });
    expect(result).toBe("SET enabled = true");
  });

  test("handles empty string values", () => {
    const sql = "SET value = '{{value}}'";
    const result = template(sql, { value: "" });
    expect(result).toBe("SET value = ''");
  });

  test("handles variables with underscores", () => {
    const sql = "halfvec({{embedding_dimensions}})";
    const result = template(sql, { embedding_dimensions: 768 });
    expect(result).toBe("halfvec(768)");
  });

  test("handles variables with numbers", () => {
    const sql = "WITH (k1 = {{bm25_k1}})";
    const result = template(sql, { bm25_k1: 1.2 });
    expect(result).toBe("WITH (k1 = 1.2)");
  });

  test("preserves text outside of variables", () => {
    const sql = "CREATE INDEX idx ON table USING {{method}} (column)";
    const result = template(sql, { method: "btree" });
    expect(result).toBe("CREATE INDEX idx ON table USING btree (column)");
  });

  test("handles variables at start of string", () => {
    const sql = "{{type}} NOT NULL";
    const result = template(sql, { type: "UUID" });
    expect(result).toBe("UUID NOT NULL");
  });

  test("handles variables at end of string", () => {
    const sql = "CREATE TYPE {{type}}";
    const result = template(sql, { type: "custom" });
    expect(result).toBe("CREATE TYPE custom");
  });

  test("handles no variables", () => {
    const sql = "CREATE TABLE foo (id UUID)";
    const result = template(sql, {});
    expect(result).toBe("CREATE TABLE foo (id UUID)");
  });

  test("handles real migration template", () => {
    const sql = "halfvec({{embedding_dimensions}})";
    const result = template(sql, { embedding_dimensions: 1536 });
    expect(result).toBe("halfvec(1536)");
  });

  test("handles BM25 index template", () => {
    const sql =
      "with (text_config = '{{bm25_text_config}}', k1 = {{bm25_k1}}, b = {{bm25_b}})";
    const result = template(sql, {
      bm25_text_config: "english",
      bm25_k1: 1.2,
      bm25_b: 0.75,
    });
    expect(result).toBe("with (text_config = 'english', k1 = 1.2, b = 0.75)");
  });

  test("handles HNSW index template", () => {
    const sql =
      "with (m = {{hnsw_m}}, ef_construction = {{hnsw_ef_construction}})";
    const result = template(sql, {
      hnsw_m: 16,
      hnsw_ef_construction: 64,
    });
    expect(result).toBe("with (m = 16, ef_construction = 64)");
  });

  test("handles schema variable substitution", () => {
    const sql = "CREATE TABLE {{schema}}.memory (id uuid)";
    const result = template(sql, { schema: "me_abc123def456" });
    expect(result).toBe("CREATE TABLE me_abc123def456.memory (id uuid)");
  });
});

describe("config merging", () => {
  test("merging empty config uses defaults", () => {
    const resolved = resolveConfig("me_test123test");
    expect(resolved.embedding_dimensions).toBe(1536);
    expect(resolved.bm25_text_config).toBe("english");
    expect(resolved.bm25_k1).toBe(1.2);
    expect(resolved.bm25_b).toBe(0.75);
    expect(resolved.hnsw_m).toBe(16);
    expect(resolved.hnsw_ef_construction).toBe(64);
    expect(resolved.schema).toBe("me_test123test");
  });

  test("partial override only changes specified values", () => {
    const resolved = resolveConfig("me_test123test", {
      embedding_dimensions: 768,
    });
    expect(resolved.embedding_dimensions).toBe(768);
    expect(resolved.bm25_text_config).toBe("english");
  });

  test("multiple overrides work correctly", () => {
    const resolved = resolveConfig("me_test123test", {
      embedding_dimensions: 384,
      bm25_text_config: "simple",
      hnsw_m: 32,
    });
    expect(resolved.embedding_dimensions).toBe(384);
    expect(resolved.bm25_text_config).toBe("simple");
    expect(resolved.hnsw_m).toBe(32);
    expect(resolved.bm25_k1).toBe(1.2);
    expect(resolved.bm25_b).toBe(0.75);
  });

  test("numeric config values preserved as numbers", () => {
    const resolved = resolveConfig("me_test123test", {
      bm25_k1: 2.5,
      bm25_b: 0.9,
    });
    expect(typeof resolved.bm25_k1).toBe("number");
    expect(typeof resolved.bm25_b).toBe("number");
    expect(resolved.bm25_k1).toBe(2.5);
    expect(resolved.bm25_b).toBe(0.9);
  });

  test("schema is always set from argument", () => {
    const resolved = resolveConfig("me_abc123def456", {
      embedding_dimensions: 768,
    });
    expect(resolved.schema).toBe("me_abc123def456");
  });
});

describe("defaultConfig", () => {
  test("has all required fields", () => {
    expect(defaultConfig.embedding_dimensions).toBe(1536);
    expect(defaultConfig.bm25_text_config).toBe("english");
    expect(defaultConfig.bm25_k1).toBe(1.2);
    expect(defaultConfig.bm25_b).toBe(0.75);
    expect(defaultConfig.hnsw_m).toBe(16);
    expect(defaultConfig.hnsw_ef_construction).toBe(64);
  });
});
