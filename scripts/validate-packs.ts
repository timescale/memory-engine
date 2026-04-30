#!/usr/bin/env bun
/**
 * Validate every memory pack in packs/ and verify cross-pack invariants.
 *
 * Reuses the parser from packages/cli/parsers/pack.ts so this script and
 * `me pack validate` can never drift.
 *
 * Checks:
 *   1. Per-pack — envelope fields, schema, IDs match id-prefix
 *      (parsePack + validatePackConstraints)
 *   2. Cross-pack — no duplicate names, no duplicate id-prefixes
 *   3. Registry — every pack's (name, id-prefix) matches packs/registry.yaml,
 *      no orphan registry entries (warning), no missing entries (error)
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — any pack fails validation OR any cross-pack/registry check fails
 *
 * Usage:
 *   ./bun run scripts/validate-packs.ts [packs-dir]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as yamlParse } from "yaml";
import {
  parsePack,
  validatePackConstraints,
} from "../packages/cli/parsers/pack.ts";

// =============================================================================
// Args
// =============================================================================

const repoRoot = resolve(import.meta.dir, "..");
const packsDir = resolve(Bun.argv[2] ?? join(repoRoot, "packs"));
const registryPath = join(packsDir, "registry.yaml");

// =============================================================================
// Helpers
// =============================================================================

/**
 * Pack envelopes use ltree-safe names (underscore), registry entries use
 * display names (hyphen). Normalise both to a canonical form for comparison.
 */
function canonicalName(name: string): string {
  return name.replaceAll("_", "-");
}

function readRegistry(path: string): Map<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read registry at ${path}: ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = yamlParse(raw);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid YAML in registry at ${path}: ${msg}`);
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !("prefixes" in parsed) ||
    typeof (parsed as { prefixes: unknown }).prefixes !== "object" ||
    (parsed as { prefixes: unknown }).prefixes === null
  ) {
    throw new Error(
      `Registry at ${path} must be a mapping with a 'prefixes' object`,
    );
  }

  const prefixes = (parsed as { prefixes: Record<string, unknown> }).prefixes;
  const map = new Map<string, string>();
  for (const [prefix, name] of Object.entries(prefixes)) {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(
        `Registry entry '${prefix}' must map to a non-empty string`,
      );
    }
    if (!/^[0-9a-f]{8}$/.test(prefix)) {
      throw new Error(
        `Registry prefix '${prefix}' must be 8 lowercase hex characters`,
      );
    }
    map.set(prefix, name);
  }
  return map;
}

function listPackFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read packs dir ${dir}: ${msg}`);
  }
  return entries
    .filter((e) => e.endsWith(".yaml") || e.endsWith(".yml"))
    .filter((e) => e !== "registry.yaml")
    .map((e) => join(dir, e))
    .filter((p) => statSync(p).isFile())
    .sort();
}

// =============================================================================
// Main
// =============================================================================

interface PackSummary {
  file: string;
  name: string;
  version: string;
  idPrefix: string;
  memories: number;
}

const errors: string[] = [];
const warnings: string[] = [];

let registry: Map<string, string>;
try {
  registry = readRegistry(registryPath);
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const files = listPackFiles(packsDir);
if (files.length === 0) {
  console.error(`FAIL: no pack files found in ${packsDir}`);
  process.exit(1);
}

const packs: PackSummary[] = [];

for (const file of files) {
  const rel = file.replace(`${repoRoot}/`, "");
  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch (error) {
    errors.push(
      `${rel}: failed to read — ${error instanceof Error ? error.message : error}`,
    );
    continue;
  }

  try {
    const pack = parsePack(content, rel);
    const constraintErrors = validatePackConstraints(pack, rel);
    if (constraintErrors.length > 0) {
      for (const e of constraintErrors) errors.push(e);
      continue;
    }
    packs.push({
      file: rel,
      name: pack.envelope.name,
      version: pack.envelope.version,
      idPrefix: pack.envelope.idPrefix,
      memories: pack.memories.length,
    });
  } catch (error) {
    errors.push(`${rel}: ${error instanceof Error ? error.message : error}`);
  }
}

// Cross-pack: duplicate names
const namesSeen = new Map<string, string>();
for (const p of packs) {
  const prior = namesSeen.get(p.name);
  if (prior) {
    errors.push(`Duplicate pack name '${p.name}': ${prior} and ${p.file}`);
  } else {
    namesSeen.set(p.name, p.file);
  }
}

// Cross-pack: duplicate id-prefixes
const prefixesSeen = new Map<string, string>();
for (const p of packs) {
  const prior = prefixesSeen.get(p.idPrefix);
  if (prior) {
    errors.push(`Duplicate id-prefix '${p.idPrefix}': ${prior} and ${p.file}`);
  } else {
    prefixesSeen.set(p.idPrefix, p.file);
  }
}

// Registry consistency: each pack must have a matching registry entry
for (const p of packs) {
  const registryName = registry.get(p.idPrefix);
  if (!registryName) {
    errors.push(
      `${p.file}: id-prefix '${p.idPrefix}' is not registered in packs/registry.yaml`,
    );
    continue;
  }
  if (canonicalName(registryName) !== canonicalName(p.name)) {
    errors.push(
      `${p.file}: registry says '${p.idPrefix}' belongs to '${registryName}' but pack name is '${p.name}'`,
    );
  }
}

// Registry orphans: prefixes in registry with no matching pack file
const filePrefixes = new Set(packs.map((p) => p.idPrefix));
for (const [prefix, name] of registry) {
  if (!filePrefixes.has(prefix)) {
    warnings.push(
      `Registry entry '${prefix}' (${name}) has no corresponding pack file in ${packsDir.replace(`${repoRoot}/`, "")}/`,
    );
  }
}

// =============================================================================
// Report
// =============================================================================

for (const w of warnings) console.warn(`WARN: ${w}`);

if (errors.length > 0) {
  console.error(`FAIL: ${errors.length} error(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const totalMemories = packs.reduce((sum, p) => sum + p.memories, 0);
console.log(
  `OK: ${packs.length} pack(s) validated, ${totalMemories} memories total, no conflicts`,
);
for (const p of packs) {
  console.log(`  - ${p.name} v${p.version} [${p.idPrefix}] (${p.memories})`);
}
