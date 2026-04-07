import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  buildRegistry,
  createRegistry,
  getMethod,
  hasMethod,
  listMethods,
  registerMethod,
} from "./registry";

describe("registry", () => {
  describe("createRegistry", () => {
    test("creates an empty registry", () => {
      const registry = createRegistry();
      expect(registry.size).toBe(0);
    });
  });

  describe("registerMethod", () => {
    test("registers a method", () => {
      const registry = createRegistry();
      const schema = z.object({ name: z.string() });
      const handler = () => ({ result: "ok" });

      registerMethod(registry, "test.method", schema, handler);

      expect(registry.size).toBe(1);
      expect(registry.has("test.method")).toBe(true);
    });

    test("overwrites existing method", () => {
      const registry = createRegistry();
      const schema1 = z.object({ v: z.number() });
      const schema2 = z.object({ v: z.string() });
      const handler1 = () => ({ v: 1 });
      const handler2 = () => ({ v: "two" });

      registerMethod(registry, "test.method", schema1, handler1);
      registerMethod(registry, "test.method", schema2, handler2);

      expect(registry.size).toBe(1);
      const method = getMethod(registry, "test.method");
      expect(
        method?.handler({}, { request: new Request("http://test") }),
      ).toEqual({ v: "two" });
    });
  });

  describe("getMethod", () => {
    test("returns registered method", () => {
      const registry = createRegistry();
      const schema = z.object({ x: z.number() });
      const handler = (params: { x: number }) => ({ doubled: params.x * 2 });

      registerMethod(registry, "math.double", schema, handler);
      const method = getMethod(registry, "math.double");

      expect(method).toBeDefined();
      expect(method?.schema).toBe(schema);
    });

    test("returns undefined for unknown method", () => {
      const registry = createRegistry();
      const method = getMethod(registry, "unknown");

      expect(method).toBeUndefined();
    });
  });

  describe("hasMethod", () => {
    test("returns true for registered method", () => {
      const registry = createRegistry();
      registerMethod(registry, "test", z.undefined(), () => null);

      expect(hasMethod(registry, "test")).toBe(true);
    });

    test("returns false for unknown method", () => {
      const registry = createRegistry();

      expect(hasMethod(registry, "unknown")).toBe(false);
    });
  });

  describe("listMethods", () => {
    test("returns empty array for empty registry", () => {
      const registry = createRegistry();

      expect(listMethods(registry)).toEqual([]);
    });

    test("returns all method names", () => {
      const registry = createRegistry();
      registerMethod(registry, "a", z.undefined(), () => null);
      registerMethod(registry, "b", z.undefined(), () => null);
      registerMethod(registry, "c", z.undefined(), () => null);

      const methods = listMethods(registry);
      expect(methods).toHaveLength(3);
      expect(methods).toContain("a");
      expect(methods).toContain("b");
      expect(methods).toContain("c");
    });
  });

  describe("buildRegistry", () => {
    test("builds registry with fluent API", () => {
      const registry = buildRegistry()
        .register("method.one", z.object({ a: z.string() }), () => 1)
        .register("method.two", z.object({ b: z.number() }), () => 2)
        .build();

      expect(registry.size).toBe(2);
      expect(hasMethod(registry, "method.one")).toBe(true);
      expect(hasMethod(registry, "method.two")).toBe(true);
    });

    test("merge combines registries", () => {
      const registry1 = buildRegistry()
        .register("a", z.undefined(), () => "a")
        .build();

      const registry2 = buildRegistry()
        .register("b", z.undefined(), () => "b")
        .merge(registry1)
        .build();

      expect(registry2.size).toBe(2);
      expect(hasMethod(registry2, "a")).toBe(true);
      expect(hasMethod(registry2, "b")).toBe(true);
    });
  });
});
