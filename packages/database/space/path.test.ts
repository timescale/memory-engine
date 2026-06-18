import { describe, expect, test } from "bun:test";
import {
  classifyTreeFilter,
  denormalizeTreePath,
  homePrefix,
  normalizeTreeFilter,
  normalizeTreePath,
  TreePathError,
} from "./path";

const ID = "0199c2a4-f8e1-7b3c-9d2e-5a6f08b4c1d7";
const HOME = "home.0199c2a4f8e17b3c9d2e5a6f08b4c1d7";
// An agent's home nests under its owner's: home.<owner>.<agent>.
const AGENT = "0199dddd-1111-7222-8333-444455556666";
const AGENT_HOME = `home.${ID.replace(/-/g, "")}.${AGENT.replace(/-/g, "")}`;

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

  test("an agent's ~ nests under its owner's home (homeOwner)", () => {
    const opts = { home: AGENT, homeOwner: ID };
    expect(normalizeTreePath("~", opts)).toBe(AGENT_HOME);
    expect(normalizeTreePath("~/bar", opts)).toBe(`${AGENT_HOME}.bar`);
    expect(normalizeTreePath("~/a/b", opts)).toBe(`${AGENT_HOME}.a.b`);
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

describe("classifyTreeFilter", () => {
  test("empty input is no filter", () => {
    expect(classifyTreeFilter("")).toBeNull();
    expect(classifyTreeFilter("/")).toBeNull();
    expect(classifyTreeFilter("  ")).toBeNull();
  });

  test("a bare path classifies as ltree (containment)", () => {
    expect(classifyTreeFilter("share")).toEqual({
      kind: "ltree",
      value: "share",
    });
    expect(classifyTreeFilter("/share/projects/")).toEqual({
      kind: "ltree",
      value: "share.projects",
    });
    expect(classifyTreeFilter("my-proj.notes_2")).toEqual({
      kind: "ltree",
      value: "my-proj.notes_2",
    });
  });

  test("a wildcard classifies as lquery", () => {
    expect(classifyTreeFilter("share.projects.*")).toEqual({
      kind: "lquery",
      value: "share.projects.*",
    });
    expect(classifyTreeFilter("*.api.*")).toEqual({
      kind: "lquery",
      value: "*.api.*",
    });
    // `|` and `!` are lquery label operators, not ltxtquery here.
    expect(classifyTreeFilter("foo|bar.baz")).toEqual({
      kind: "lquery",
      value: "foo|bar.baz",
    });
  });

  test("an `&` boolean classifies as ltxtquery", () => {
    expect(classifyTreeFilter("api & v2")).toEqual({
      kind: "ltxtquery",
      value: "api & v2",
    });
  });

  test("a leading ~ expands before classification", () => {
    expect(classifyTreeFilter("~.*", { home: ID })).toEqual({
      kind: "lquery",
      value: `${HOME}.*`,
    });
    expect(classifyTreeFilter("~/notes", { home: ID })).toEqual({
      kind: "ltree",
      value: `${HOME}.notes`,
    });
  });
});

describe("homePrefix", () => {
  test("strips hyphens from the principal id", () => {
    expect(homePrefix(ID)).toBe(HOME);
  });

  test("nests under the owner when an owner id is given (agent home)", () => {
    expect(homePrefix(AGENT, ID)).toBe(AGENT_HOME);
  });
});

describe("denormalizeTreePath", () => {
  test("reverse-maps the caller's home to ~ (no leading slash; ~ is the anchor)", () => {
    expect(denormalizeTreePath(HOME, { home: ID })).toBe("~");
    expect(denormalizeTreePath(`${HOME}.bar`, { home: ID })).toBe("~/bar");
    expect(denormalizeTreePath(`${HOME}.a.b`, { home: ID })).toBe("~/a/b");
  });

  test("renders non-home paths (and other principals' homes) as absolute /paths", () => {
    expect(denormalizeTreePath("work.projects", { home: ID })).toBe(
      "/work/projects",
    );
    expect(denormalizeTreePath("home.deadbeef.x", { home: ID })).toBe(
      "/home/deadbeef/x",
    );
    // no home opt → still an absolute slash path
    expect(denormalizeTreePath(`${HOME}.bar`)).toBe(
      `/${HOME.replace(/\./g, "/")}/bar`,
    );
  });

  test("the empty root renders as /", () => {
    expect(denormalizeTreePath("", { home: ID })).toBe("/");
    expect(denormalizeTreePath("")).toBe("/");
  });

  test("round-trips with normalizeTreePath", () => {
    const home = denormalizeTreePath(`${HOME}.a.b`, { home: ID }); // ~/a/b
    expect(normalizeTreePath(home, { home: ID })).toBe(`${HOME}.a.b`);
    const abs = denormalizeTreePath("work.projects"); // /work/projects
    expect(normalizeTreePath(abs)).toBe("work.projects"); // leading slash stripped
  });

  test("reverse-maps an agent's nested home (homeOwner) to ~", () => {
    const opts = { home: AGENT, homeOwner: ID };
    expect(denormalizeTreePath(AGENT_HOME, opts)).toBe("~");
    expect(denormalizeTreePath(`${AGENT_HOME}.a.b`, opts)).toBe("~/a/b");
    // the owner's own home (one level up) is NOT the agent's ~
    expect(denormalizeTreePath(HOME, opts)).toBe(
      `/${HOME.replace(/\./g, "/")}`,
    );
  });
});
