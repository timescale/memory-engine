#!/usr/bin/env bun

// Generates and publishes npm packages for the me CLI binary.
//
// Creates 4 packages:
//   @memory.build/cli              - main package with JS wrapper + optionalDependencies
//   @memory.build/cli-linux-x64    - linux x64 binary
//   @memory.build/cli-linux-arm64  - linux arm64 binary
//   @memory.build/cli-darwin-arm64 - darwin arm64 binary
//
// Usage:
//   ./bun scripts/npm/publish.ts --version 0.13.0 --binaries-dir ./binaries [--dry-run]

import { chmod, cp, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const SCOPE = "@memory.build";
const MAIN_PACKAGE = `${SCOPE}/cli`;

// Resolve the project-root `./bun` wrapper to an absolute path so it works
// regardless of the cwd we pass to Bun.spawn when publishing packages.
const PROJECT_ROOT = resolve(dirname(import.meta.dir), "..");
const BUN = join(PROJECT_ROOT, "bun");

// npm 11.5.1+ is required for OIDC authentication to npm trusted publishers.
// Use `./bun x` to run a recent npm without requiring it to be globally installed.
const NPM_CMD = [BUN, "x", "npm@>=11.5.1"];

interface PlatformTarget {
  os: string;
  cpu: string;
  binaryName: string;
  packageSuffix: string;
}

const PLATFORMS: PlatformTarget[] = [
  {
    os: "linux",
    cpu: "x64",
    binaryName: "me-linux-x64",
    packageSuffix: "cli-linux-x64",
  },
  {
    os: "linux",
    cpu: "arm64",
    binaryName: "me-linux-arm64",
    packageSuffix: "cli-linux-arm64",
  },
  {
    os: "darwin",
    cpu: "arm64",
    binaryName: "me-darwin-arm64",
    packageSuffix: "cli-darwin-arm64",
  },
  {
    os: "windows",
    cpu: "x64",
    binaryName: "me-windows-x64.exe",
    packageSuffix: "cli-windows-x64",
  },
];

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function npmPublish(packageDir: string, dryRun: boolean): Promise<void> {
  const args = [...NPM_CMD, "publish", "--access", "public"];
  if (dryRun) {
    args.push("--dry-run");
  }

  console.log(
    `  ${dryRun ? "[dry-run] " : ""}${args.join(" ")} (in ${packageDir})`,
  );
  const proc = Bun.spawn(args, {
    cwd: packageDir,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    fail(`npm publish failed for ${packageDir} (exit code ${exitCode})`);
  }
}

function makePlatformPackageJson(
  target: PlatformTarget,
  version: string,
): string {
  const pkg = {
    name: `${SCOPE}/${target.packageSuffix}`,
    version,
    description: `me CLI binary for ${target.os}-${target.cpu}`,
    license: "Apache-2.0",
    repository: {
      type: "git",
      url: "git+https://github.com/timescale/me.git",
    },
    os: [target.os],
    cpu: [target.cpu],
    files: ["bin"],
  };
  return JSON.stringify(pkg, null, 2);
}

function makeMainPackageJson(version: string): string {
  const optionalDependencies: Record<string, string> = {};
  for (const target of PLATFORMS) {
    optionalDependencies[`${SCOPE}/${target.packageSuffix}`] = version;
  }

  const pkg = {
    name: MAIN_PACKAGE,
    version,
    description: "The me CLI for managing development environments",
    license: "Apache-2.0",
    repository: {
      type: "git",
      url: "git+https://github.com/timescale/me.git",
    },
    homepage: "https://memory.build",
    bin: {
      me: "bin/me",
    },
    files: ["bin"],
    optionalDependencies,
  };
  return JSON.stringify(pkg, null, 2);
}

// --- Main ---

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    "binaries-dir": { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

const version = values.version;
const binariesDir = values["binaries-dir"];
const dryRun = values["dry-run"] ?? false;

if (!version) {
  fail("--version is required");
}
if (!binariesDir) {
  fail("--binaries-dir is required");
}

const resolvedBinDir = resolve(binariesDir);
const tmpBase = join(
  process.env.RUNNER_TEMP || (await import("node:os")).tmpdir(),
  `me-npm-publish-${Date.now()}`,
);
await mkdir(tmpBase, { recursive: true });

console.log(`Publishing me ${version} to npm${dryRun ? " (dry-run)" : ""}`);
console.log(`  Binaries: ${resolvedBinDir}`);
console.log(`  Work dir: ${tmpBase}`);
console.log();

// --- Publish platform packages first ---

console.log("Publishing platform packages...");
for (const target of PLATFORMS) {
  const pkgName = `${SCOPE}/${target.packageSuffix}`;
  const pkgDir = join(tmpBase, target.packageSuffix);
  const binDir = join(pkgDir, "bin");

  await mkdir(binDir, { recursive: true });

  // Write package.json
  await Bun.write(
    join(pkgDir, "package.json"),
    makePlatformPackageJson(target, version),
  );

  // Copy binary
  const srcBinary = join(resolvedBinDir, target.binaryName);
  const dstBinary = join(binDir, "me");

  const srcFile = Bun.file(srcBinary);
  if (!(await srcFile.exists())) {
    fail(`Binary not found: ${srcBinary}`);
  }

  await cp(srcBinary, dstBinary);
  await chmod(dstBinary, 0o755);

  console.log(`  ${pkgName}@${version}`);
  await npmPublish(pkgDir, dryRun);
}

console.log();

// --- Publish main package ---

console.log("Publishing main package...");
const mainPkgDir = join(tmpBase, "cli");
const mainBinDir = join(mainPkgDir, "bin");

await mkdir(mainBinDir, { recursive: true });

// Write package.json
await Bun.write(join(mainPkgDir, "package.json"), makeMainPackageJson(version));

// Copy wrapper script
const wrapperSrc = join(import.meta.dir, "wrapper.cjs");
const wrapperDst = join(mainBinDir, "me");

const wrapperFile = Bun.file(wrapperSrc);
if (!(await wrapperFile.exists())) {
  fail(`Wrapper script not found: ${wrapperSrc}`);
}

await cp(wrapperSrc, wrapperDst);
await chmod(wrapperDst, 0o755);

console.log(`  ${MAIN_PACKAGE}@${version}`);
await npmPublish(mainPkgDir, dryRun);

console.log();
console.log(
  `Done! Published ${PLATFORMS.length + 1} packages${dryRun ? " (dry-run)" : ""}.`,
);
