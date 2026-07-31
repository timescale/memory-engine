#!/usr/bin/env bun

// Verifies packed npm tarballs before they are published.
//
// The bug this exists to prevent: `npm publish` run from inside a package
// directory does not rewrite `workspace:*` dependency specs (npm only does that
// for npm-managed workspaces, and this repo installs with bun). That shipped
// @memory.build/client@0.6.2 with a literal
//
//   "dependencies": { "@memory.build/protocol": "workspace:*" }
//
// so every consumer install failed with
// `Workspace dependency "@memory.build/protocol" not found`.
//
// The release workflow now packs with `bun pm pack` (which resolves workspace
// protocols to concrete versions) and publishes the resulting tarball. This
// script asserts that actually happened, so a regression fails the release
// instead of reaching the registry.
//
// Usage:
//   ./bun scripts/npm/verify-tarballs.ts <tarball-dir-or-file> [...]

import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** A spec that must never reach the registry: unresolvable by consumers. */
const UNPUBLISHABLE_SPEC_PREFIXES = ["workspace:", "file:", "link:", "portal:"];

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Read `package/package.json` out of a tarball, via tar on stdout. */
async function readPackedManifest(tarball: string): Promise<unknown> {
  const proc = Bun.spawn(["tar", "-xzOf", tarball, "package/package.json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    fail(`could not read package.json from ${tarball}: ${stderr.trim()}`);
  }
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    fail(`package.json in ${tarball} is not valid JSON: ${String(cause)}`);
  }
}

/** Collect every `.tgz` implied by the given files/directories. */
async function resolveTarballPaths(inputs: string[]): Promise<string[]> {
  const tarballs: string[] = [];
  for (const input of inputs) {
    const stat = await Bun.file(input)
      .stat()
      .catch(() => null);
    if (stat?.isDirectory()) {
      const entries = await readdir(input);
      tarballs.push(
        ...entries.filter((e) => e.endsWith(".tgz")).map((e) => join(input, e)),
      );
    } else if (stat) {
      tarballs.push(input);
    } else {
      fail(`no such file or directory: ${input}`);
    }
  }
  return tarballs.sort();
}

/**
 * Check one packed manifest, returning human-readable problems.
 *
 * Exported for tests; the checks are pure so they can be exercised without
 * building or packing anything.
 */
export function findUnpublishableSpecs(
  manifest: unknown,
): { field: string; name: string; spec: string }[] {
  const problems: { field: string; name: string; spec: string }[] = [];
  if (typeof manifest !== "object" || manifest === null) return problems;
  const record = manifest as Record<string, unknown>;

  for (const field of DEPENDENCY_FIELDS) {
    const deps = record[field];
    if (typeof deps !== "object" || deps === null) continue;
    for (const [name, spec] of Object.entries(
      deps as Record<string, unknown>,
    )) {
      if (typeof spec !== "string") continue;
      if (UNPUBLISHABLE_SPEC_PREFIXES.some((p) => spec.startsWith(p))) {
        problems.push({ field, name, spec });
      }
    }
  }
  return problems;
}

// --- Main ---

if (import.meta.main) {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    fail("usage: verify-tarballs.ts <tarball-dir-or-file> [...]");
  }

  const tarballs = await resolveTarballPaths(inputs);
  if (tarballs.length === 0) {
    fail(`no .tgz tarballs found in: ${inputs.join(", ")}`);
  }

  let failed = false;
  for (const tarball of tarballs) {
    const manifest = await readPackedManifest(tarball);
    const { name, version } = manifest as { name?: string; version?: string };
    const problems = findUnpublishableSpecs(manifest);

    if (problems.length > 0) {
      failed = true;
      console.error(`\n${basename(tarball)} (${name}@${version}) is broken:`);
      for (const { field, name: dep, spec } of problems) {
        console.error(
          `  ${field}.${dep} = "${spec}" (unresolvable for consumers)`,
        );
      }
    } else {
      console.log(`ok ${name}@${version} (${basename(tarball)})`);
    }
  }

  if (failed) {
    console.error(
      "\nPack tarballs with `bun pm pack` (it resolves workspace: specs to " +
        "concrete versions), not `npm publish` from the package directory.",
    );
    process.exit(1);
  }

  console.log(`\nVerified ${tarballs.length} tarball(s).`);
}
