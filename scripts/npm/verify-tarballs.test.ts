import { describe, expect, test } from "bun:test";

import { findUnpublishableSpecs } from "./verify-tarballs.ts";

describe("findUnpublishableSpecs", () => {
  test("flags the workspace:* spec that broke @memory.build/client@0.6.2", () => {
    const problems = findUnpublishableSpecs({
      name: "@memory.build/client",
      version: "0.6.2",
      dependencies: { "@memory.build/protocol": "workspace:*" },
    });

    expect(problems).toEqual([
      {
        field: "dependencies",
        name: "@memory.build/protocol",
        spec: "workspace:*",
      },
    ]);
  });

  test("accepts a manifest whose workspace spec was resolved by bun pm pack", () => {
    expect(
      findUnpublishableSpecs({
        name: "@memory.build/client",
        version: "0.6.2",
        dependencies: { "@memory.build/protocol": "0.6.2" },
        peerDependencies: { typescript: "^5.0.0" },
      }),
    ).toEqual([]);
  });

  test("checks every dependency field, not just dependencies", () => {
    const problems = findUnpublishableSpecs({
      dependencies: { a: "1.0.0" },
      devDependencies: { b: "workspace:^" },
      peerDependencies: { c: "link:../c" },
      optionalDependencies: { d: "file:../d" },
    });

    expect(problems.map((p) => `${p.field}.${p.name}`).sort()).toEqual([
      "devDependencies.b",
      "optionalDependencies.d",
      "peerDependencies.c",
    ]);
  });

  test("tolerates manifests with no dependency fields or odd shapes", () => {
    expect(findUnpublishableSpecs({ name: "x", version: "1.0.0" })).toEqual([]);
    expect(findUnpublishableSpecs({ dependencies: null })).toEqual([]);
    expect(findUnpublishableSpecs(null)).toEqual([]);
    expect(findUnpublishableSpecs("nonsense")).toEqual([]);
  });
});
