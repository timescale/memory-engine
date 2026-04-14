// Release script — bump version, commit, tag, push.
//
// Usage:
//   ./bun scripts/release.ts 0.2.0
//   ./bun scripts/release.ts          # prompts for version
//   ./bun run release 0.2.0

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { $ } from "bun";

const root = join(import.meta.dirname, "..");

// All package.json files that carry a version field.
const PACKAGE_JSONS = [
  "package.json",
  "packages/accounts/package.json",
  "packages/cli/package.json",
  "packages/client/package.json",
  "packages/embedding/package.json",
  "packages/engine/package.json",
  "packages/protocol/package.json",
  "packages/server/package.json",
  "packages/worker/package.json",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg: string): never {
  console.error(`\x1b[31merror:\x1b[0m ${msg}`);
  process.exit(1);
}

function info(msg: string) {
  console.log(`\x1b[36m>\x1b[0m ${msg}`);
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`\x1b[33m?\x1b[0m ${question} `)).trim();
  } finally {
    rl.close();
  }
}

/** Read current version from root package.json. */
function currentVersion(): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  return pkg.version;
}

/** Validate that a string is a valid semver (no v prefix). */
function validateSemver(v: string): boolean {
  return Bun.semver.satisfies(v, "*");
}

/** Update the "version" field in a package.json, preserving formatting. */
function bumpFile(relPath: string, version: string) {
  const absPath = join(root, relPath);
  const raw = readFileSync(absPath, "utf-8");
  // Match the "version": "..." line and replace the value
  const updated = raw.replace(
    /("version"\s*:\s*")([^"]+)(")/,
    `$1${version}$3`,
  );
  if (updated === raw) {
    die(`failed to update version in ${relPath}`);
  }
  writeFileSync(absPath, updated);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// 1. Ensure we're on main with a clean working tree
const branch = (
  await $`git rev-parse --abbrev-ref HEAD`.cwd(root).text()
).trim();
if (branch !== "main") {
  die(`must be on main branch (currently on ${branch})`);
}

const status = (await $`git status --porcelain`.cwd(root).text()).trim();
if (status) {
  die("working tree has uncommitted changes");
}

// Make sure we're up to date with remote
await $`git fetch origin main --quiet`.cwd(root);
const local = (await $`git rev-parse HEAD`.cwd(root).text()).trim();
const remote = (await $`git rev-parse origin/main`.cwd(root).text()).trim();
if (local !== remote) {
  die("local main is not up to date with origin/main — pull or push first");
}

// 2. Determine the new version
const current = currentVersion();
let version = process.argv[2];

if (!version) {
  version = await prompt(`New version (current: ${current}):`);
}

// Strip leading "v" if provided
version = version.replace(/^v/, "");

if (!validateSemver(version)) {
  die(`invalid semver: ${version}`);
}

// 3. Must be greater than current version
if (Bun.semver.order(version, current) !== 1) {
  die(`version ${version} is not greater than current ${current}`);
}

// Check the tag doesn't already exist
const tagExists =
  (await $`git tag -l v${version}`.cwd(root).text()).trim() !== "";
if (tagExists) {
  die(`tag v${version} already exists`);
}

// 4. Confirm
const tag = `v${version}`;
info(`${current} -> ${version}`);

const confirm = await prompt(`Release ${tag}? (y/N)`);
if (confirm.toLowerCase() !== "y") {
  die("aborted");
}

// 5. Bump version in all package.json files
for (const file of PACKAGE_JSONS) {
  bumpFile(file, version);
  info(`bumped ${file}`);
}

// 6. Commit and tag
await $`git add -A`.cwd(root);
await $`git commit -m ${tag}`.cwd(root);
await $`git tag -a ${tag} -m ${tag}`.cwd(root);
info(`committed and tagged ${tag}`);

// 7. Push commit and tag
await $`git push origin main --follow-tags`.cwd(root);
info(`pushed ${tag} to origin`);

console.log(`\n\x1b[32mdone\x1b[0m — release ${tag} is live`);
