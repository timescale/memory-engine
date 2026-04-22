// Server release script — bump version, commit, tag `server/v<version>`, push.
//
// Bumps `packages/server/package.json` (the canonical source of truth for
// SERVER_VERSION, see version.ts) plus its sibling internal packages that
// make up the server image. Pushing the `server/v<version>` tag triggers
// `.github/workflows/deploy-prod.yaml` (build + deploy to prod).
//
// Does NOT release the CLI or npm packages. For that, use
// `./bun run release:client`.
//
// Usage:
//   ./bun scripts/release-server.ts 0.2.0
//   ./bun scripts/release-server.ts patch     # 0.1.16 -> 0.1.17
//   ./bun scripts/release-server.ts minor     # 0.1.16 -> 0.2.0
//   ./bun scripts/release-server.ts major     # 0.1.16 -> 1.0.0
//   ./bun scripts/release-server.ts           # prompts for version
//   ./bun run release:server 0.2.0

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { $ } from "bun";
import semver from "semver";

const root = join(import.meta.dirname, "..");

// Server-side package.json files. `packages/server/package.json` is the
// canonical source of truth for SERVER_VERSION; the other four are sibling
// internal packages consumed by the server via `workspace:*`. They are
// bumped in lockstep for visual consistency — none of them publish.
const PACKAGE_JSONS = [
  "packages/accounts/package.json",
  "packages/embedding/package.json",
  "packages/engine/package.json",
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

/** Read current version from packages/server/package.json. */
function currentVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(root, "packages/server/package.json"), "utf-8"),
  );
  return pkg.version;
}

const INCREMENT_TYPES = ["major", "minor", "patch"] as const;
type IncrementType = (typeof INCREMENT_TYPES)[number];

function isIncrementType(value: string): value is IncrementType {
  return (INCREMENT_TYPES as ReadonlyArray<string>).includes(value);
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
let versionArg = process.argv[2];

if (!versionArg) {
  versionArg = await prompt(
    `New version or increment type [major|minor|patch] (current: ${current}):`,
  );
}

// Strip leading "v" if provided
versionArg = versionArg.replace(/^v/, "");

// Resolve increment type (major/minor/patch) to a concrete version
const version = isIncrementType(versionArg)
  ? semver.inc(current, versionArg)
  : versionArg;

if (!version || !semver.valid(version)) {
  die(`invalid semver: ${version}`);
}

// 3. Must be greater than current version
if (!semver.gt(version, current)) {
  die(`version ${version} is not greater than current ${current}`);
}

// Check the tag doesn't already exist
const tag = `server/v${version}`;
const tagExists = (await $`git tag -l ${tag}`.cwd(root).text()).trim() !== "";
if (tagExists) {
  die(`tag ${tag} already exists`);
}

// 4. Confirm
info(`${current} -> ${version}`);

const confirm = await prompt(`Release server ${tag}? (y/N)`);
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

console.log(`\n\x1b[32mdone\x1b[0m — server release ${tag} is live`);
