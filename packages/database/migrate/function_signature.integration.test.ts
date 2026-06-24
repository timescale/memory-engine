// Integration tests for the function-signature migration helpers installed by
// runSchemaMigrations (migrate/function_signature.sql): the {{fn}} template
// block expands to a drop_function_if_signature_differs guard before a
// create-or-replace and an assert_function_signature check after. Here we drive
// the two SQL functions directly against throwaway functions in a provisioned
// space schema (which is where the helpers live).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Sql as SQL } from "postgres";
import { bootstrapSpaceDatabase } from "../space/migrate/bootstrap";
import { connect, expectReject, TestSpace } from "../space/migrate/test-utils";

let sql: SQL;
let space: TestSpace;
let s: string;

beforeAll(async () => {
  sql = connect();
  await bootstrapSpaceDatabase(sql);
  space = await TestSpace.create(sql, { embeddingDimensions: 4 });
  s = space.schema;
});

afterAll(async () => {
  await space?.drop();
  await sql.end();
});

/**
 * Create/replace a throwaway function `<schema>.<signature>` with a trivial
 * plpgsql body matching its declared return: a set-returning (`table`/`setof`)
 * function gets a bare `return;` (empty set), a scalar gets `return null;`. So
 * the test never trips return-type validation regardless of the signature.
 */
async function mkfn(signature: string): Promise<void> {
  const ret = /\breturns\s+(table|setof)\b/i.test(signature)
    ? "return;"
    : "return null;";
  await sql.unsafe(
    `create or replace function ${s}.${signature} as $b$ begin ${ret} end $b$ language plpgsql`,
  );
}

async function dropIfDiffers(
  name: string,
  args: string,
  result: string,
): Promise<number> {
  const [row] = await sql.unsafe(
    `select ${s}.drop_function_if_signature_differs($1, $2, $3) as n`,
    [name, args, result],
  );
  return Number(row?.n);
}

const assertSig = (
  name: string,
  args: string,
  result: string,
): Promise<unknown> =>
  sql.unsafe(`select ${s}.assert_function_signature($1, $2, $3)`, [
    name,
    args,
    result,
  ]);

/** Identity-argument strings of every `<schema>.<name>` overload. */
async function identityArgs(name: string): Promise<string[]> {
  const rows = await sql.unsafe(
    `select pg_get_function_identity_arguments(p.oid) as a
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = $1 and p.proname = $2
     order by a`,
    [s, name],
  );
  return rows.map((r) => r.a as string);
}

describe("drop_function_if_signature_differs", () => {
  test("no-op (returns 0) when the live signature already matches the target", async () => {
    await mkfn("fs_match(_a jsonb, _b uuid) returns table(id uuid, n text)");
    expect(
      await dropIfDiffers(
        "fs_match",
        "_a jsonb, _b uuid",
        "table(id uuid, n text)",
      ),
    ).toBe(0);
    expect(await identityArgs("fs_match")).toEqual(["_a jsonb, _b uuid"]);
  });

  test("matches canonically — bool/boolean, int/integer don't count as a difference", async () => {
    await mkfn("fs_canon(_a int4) returns boolean");
    // target type spelled with the aliases `int` and `bool`
    expect(await dropIfDiffers("fs_canon", "_a int", "bool")).toBe(0);
    expect(await identityArgs("fs_canon")).toHaveLength(1);
  });

  test("matches canonically across a multi-word type spelling", async () => {
    await mkfn("fs_multiword(_a timestamp with time zone) returns int");
    // target type spelled as the alias `timestamptz`
    expect(await dropIfDiffers("fs_multiword", "_a timestamptz", "int")).toBe(
      0,
    );
    expect(await identityArgs("fs_multiword")).toEqual([
      "_a timestamp with time zone",
    ]);
  });

  test("drops a definition whose RESULT differs (the 42P13 case)", async () => {
    await mkfn("fs_result(_a jsonb) returns table(id uuid, n text)");
    expect(await dropIfDiffers("fs_result", "_a jsonb", "table(id uuid)")).toBe(
      1,
    );
    expect(await identityArgs("fs_result")).toEqual([]);
  });

  test("drops a definition whose IN-parameter NAME differs (the rename 42P13 case)", async () => {
    // same arg type + result, only the parameter name changes (j -> k) — a
    // create-or-replace would raise 42P13 "cannot change name of input
    // parameter", so the guard must drop first.
    await mkfn("fs_rename(j jsonb) returns int");
    expect(await dropIfDiffers("fs_rename", "k jsonb", "int")).toBe(1);
    expect(await identityArgs("fs_rename")).toEqual([]);
  });

  test("sweeps a stale arg-overload while keeping the matching definition", async () => {
    await mkfn("fs_over(_a jsonb, _b uuid) returns int");
    await mkfn("fs_over(_a jsonb) returns int"); // stale overload, different args
    expect(await identityArgs("fs_over")).toHaveLength(2);

    expect(await dropIfDiffers("fs_over", "_a jsonb, _b uuid", "int")).toBe(1);
    expect(await identityArgs("fs_over")).toEqual(["_a jsonb, _b uuid"]);
  });
});

describe("assert_function_signature", () => {
  test("passes when exactly one definition matches the target", async () => {
    await mkfn("as_ok(_a jsonb, _b uuid) returns table(id uuid, n text)");
    // resolves without throwing
    await assertSig("as_ok", "_a jsonb, _b uuid", "table(id uuid, n text)");
  });

  test("raises on a result drift", async () => {
    await mkfn("as_res(_a jsonb) returns table(id uuid, n text)");
    await expectReject(() => assertSig("as_res", "_a jsonb", "table(id uuid)"));
  });

  test("raises on an argument-type drift", async () => {
    await mkfn("as_arg(_a jsonb, _b uuid) returns int");
    await expectReject(() => assertSig("as_arg", "_a jsonb, _b text", "int"));
  });

  test("raises on an IN-parameter-name drift", async () => {
    await mkfn("as_name(j jsonb) returns int");
    await expectReject(() => assertSig("as_name", "k jsonb", "int"));
  });

  test("raises when a stale overload remains (more than one definition)", async () => {
    await mkfn("as_dup(_a jsonb) returns int");
    await mkfn("as_dup(_a uuid) returns int");
    await expectReject(() => assertSig("as_dup", "_a jsonb", "int"));
  });
});
