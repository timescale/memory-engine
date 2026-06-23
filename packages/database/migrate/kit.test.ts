import { describe, expect, test } from "bun:test";
import { template } from "./kit";

describe("template — {{name}} substitution", () => {
  test("substitutes known placeholders", () => {
    expect(template("create schema {{schema}}", { schema: "me_x" })).toBe(
      "create schema me_x",
    );
  });

  test("throws on an unknown placeholder", () => {
    expect(() => template("{{nope}}", { schema: "me_x" })).toThrow(
      /Missing template variable: nope/,
    );
  });
});

describe("template — {{fn ...}} / {{endfn}} block", () => {
  const wrap = (header: string, body: string) =>
    template(`{{fn ${header}}}\n${body}\n{{endfn}}`, { schema: "me_x" });

  test("brackets the body with drop + assert, signature inlined, schema applied", () => {
    const out = wrap(
      "get_memory(jsonb, uuid) returns table(id uuid, name text)",
      "create or replace function {{schema}}.get_memory() returns int as 'select 1' language sql;",
    );
    const sig = "'get_memory', 'jsonb, uuid', 'table(id uuid, name text)'";
    expect(out).toBe(
      `select me_x.drop_function_if_signature_differs(${sig});\n` +
        "create or replace function me_x.get_memory() returns int as 'select 1' language sql;\n" +
        `select me_x.assert_function_signature(${sig});`,
    );
  });

  test("preserves a multi-line body verbatim (between the generated guards)", () => {
    const body = [
      "create or replace function {{schema}}.f()",
      "returns int as $func$",
      "  select 1",
      "$func$ language sql;",
    ].join("\n");
    const out = wrap("f() returns integer", body);
    expect(out).toContain(`\n${body.replace("{{schema}}", "me_x")}\n`);
    expect(
      out.startsWith("select me_x.drop_function_if_signature_differs("),
    ).toBe(true);
    expect(
      out.trimEnd().endsWith("assert_function_signature('f', '', 'integer');"),
    ).toBe(true);
  });

  test("expands multiple blocks independently (non-greedy body match)", () => {
    const sql = [
      "{{fn a(jsonb) returns int}}",
      "create function {{schema}}.a() returns int as 'select 1' language sql;",
      "{{endfn}}",
      "{{fn b(uuid) returns text}}",
      "create function {{schema}}.b() returns text as 'select x' language sql;",
      "{{endfn}}",
    ].join("\n");
    const out = template(sql, { schema: "me_x" });
    expect(out.match(/drop_function_if_signature_differs/g)).toHaveLength(2);
    expect(out).toContain(
      "drop_function_if_signature_differs('a', 'jsonb', 'int')",
    );
    expect(out).toContain("assert_function_signature('b', 'uuid', 'text')");
    // b's body must not be swallowed into a's block
    expect(out).toContain("me_x.a() returns int");
    expect(out).toContain("me_x.b() returns text");
  });

  test("a file with no blocks is left to plain substitution", () => {
    expect(template("create table {{schema}}.t ()", { schema: "me_x" })).toBe(
      "create table me_x.t ()",
    );
  });

  test("an orphan {{endfn}} is a hard error (caught as an unknown placeholder)", () => {
    expect(() =>
      template("create function {{schema}}.f();\n{{endfn}}", {
        schema: "me_x",
      }),
    ).toThrow(/Missing template variable: endfn/);
  });
});
