import { describe, expect, test } from "bun:test";
import {
  denormalizeTreePath,
  homePrefix,
  normalizeTreeFilter,
  normalizeTreePath,
  TreePathError,
} from "./path";

const ID = "0199c2a4-f8e1-7b3c-9d2e-5a6f08b4c1d7";
const HOME = "home.0199c2a4f8e17b3c9d2e5a6f08b4c1d7";

describe("normalizeTreePath", () => {
  test("root forms collapse to the empty path", () => {
    for (const root of ["", "/", ".", "///", "..", "/.//"]) {
      expect(normalizeTreePath(root)).toBe("");
    }
  });

  test("slash and dot separators are interchangeable; runs collapse; ends trim", () => {
    expect(normalizeTreePath("foo")).toBe("foo");
    expect(normalizeTreePath("foo/bar")).toBe("foo.bar");
    expect(normalizeTreePath("foo.bar")).toBe("foo.bar");
    expect(normalizeTreePath("/foo/bar/")).toBe("foo.bar");
    expect(normalizeTreePath("foo//bar")).toBe("foo.bar");
    expect(normalizeTreePath("a/b.c")).toBe("a.b.c");
  });

  test("hyphen and underscore labels are valid", () => {
    expect(normalizeTreePath("my-project/notes_2")).toBe("my-project.notes_2");
  });

  test("rejects illegal label characters", () => {
    expect(() => normalizeTreePath("foo bar")).toThrow(TreePathError);
    expect(() => normalizeTreePath("foo@bar")).toThrow(TreePathError);
    expect(() => normalizeTreePath("a/b!c")).toThrow(TreePathError);
  });

  test("leading ~ expands to the caller's home", () => {
    expect(normalizeTreePath("~", { home: ID })).toBe(HOME);
    expect(normalizeTreePath("~/bar", { home: ID })).toBe(`${HOME}.bar`);
    expect(normalizeTreePath("~.bar", { home: ID })).toBe(`${HOME}.bar`);
    expect(normalizeTreePath("~/a/b", { home: ID })).toBe(`${HOME}.a.b`);
  });

  test("~ requires a home and is only valid as the first segment", () => {
    expect(() => normalizeTreePath("~/bar")).toThrow(TreePathError);
    expect(() => normalizeTreePath("foo/~/bar", { home: ID })).toThrow(
      TreePathError,
    );
  });

  test("a literal 'home' path is not special (only ~ injects the id)", () => {
    expect(normalizeTreePath("home/bar", { home: ID })).toBe("home.bar");
  });
});

describe("normalizeTreeFilter", () => {
  test("passes lquery / ltxtquery syntax through unvalidated", () => {
    expect(normalizeTreeFilter("*")).toBe("*");
    expect(normalizeTreeFilter("*.api.*")).toBe("*.api.*");
    expect(normalizeTreeFilter("foo & bar")).toBe("foo & bar");
  });

  test("normalizes separators and trims", () => {
    expect(normalizeTreeFilter("")).toBe("");
    expect(normalizeTreeFilter("/foo/bar/")).toBe("foo.bar");
    expect(normalizeTreeFilter("foo//bar")).toBe("foo.bar");
  });

  test("expands a leading ~ but keeps the wildcard remainder", () => {
    expect(normalizeTreeFilter("~", { home: ID })).toBe(HOME);
    expect(normalizeTreeFilter("~/proj.*", { home: ID })).toBe(
      `${HOME}.proj.*`,
    );
    expect(normalizeTreeFilter("~.*", { home: ID })).toBe(`${HOME}.*`);
  });
});

describe("homePrefix", () => {
  test("strips hyphens from the principal id", () => {
    expect(homePrefix(ID)).toBe(HOME);
  });
});

describe("denormalizeTreePath", () => {
  test("reverse-maps the caller's home to ~ with slash separators", () => {
    expect(denormalizeTreePath(HOME, { home: ID })).toBe("~");
    expect(denormalizeTreePath(`${HOME}.bar`, { home: ID })).toBe("~/bar");
    expect(denormalizeTreePath(`${HOME}.a.b`, { home: ID })).toBe("~/a/b");
  });

  test("leaves non-home paths (and other principals' homes) unchanged", () => {
    expect(denormalizeTreePath("work.projects", { home: ID })).toBe(
      "work.projects",
    );
    expect(denormalizeTreePath("home.deadbeef.x", { home: ID })).toBe(
      "home.deadbeef.x",
    );
    expect(denormalizeTreePath(`${HOME}.bar`)).toBe(`${HOME}.bar`); // no home opt
  });

  test("round-trips with normalizeTreePath", () => {
    const display = denormalizeTreePath(`${HOME}.a.b`, { home: ID }); // ~/a/b
    expect(normalizeTreePath(display, { home: ID })).toBe(`${HOME}.a.b`);
  });
});
