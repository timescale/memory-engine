#!/usr/bin/env bun

// Generates and publishes the Homebrew formula for the me CLI.
//
// Computes SHA256 hashes of the release binaries, generates the me.rb formula,
// then clones timescale/homebrew-tap and pushes the updated formula.
//
// Usage:
//   ./bun scripts/brew/update-formula.ts --version 0.13.0 --binaries-dir ./binaries [--dry-run]
//
// Requires HOMEBREW_TAP_GITHUB_TOKEN env var for pushing to the tap repo.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const TAP_REPO = "timescale/homebrew-tap";
const FORMULA_FILE = "me.rb";

interface PlatformTarget {
  binaryName: string;
  rubyOs: string;
  rubyArch: string;
}

const PLATFORMS: PlatformTarget[] = [
  {
    binaryName: "me-darwin-arm64",
    rubyOs: "on_macos",
    rubyArch: "on_arm",
  },
  {
    binaryName: "me-linux-arm64",
    rubyOs: "on_linux",
    rubyArch: "on_arm",
  },
  {
    binaryName: "me-linux-x64",
    rubyOs: "on_linux",
    rubyArch: "on_intel",
  },
];

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function sha256(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function run(
  command: string[],
  options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  const childProcess = Bun.spawn(command, {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await childProcess.exited;
  const stdout = await new Response(childProcess.stdout).text();
  const stderr = await new Response(childProcess.stderr).text();
  if (exitCode !== 0) {
    fail(`Command failed (exit ${exitCode}): ${command.join(" ")}\n${stderr}`);
  }
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

function generateFormula(version: string, hashes: Map<string, string>): string {
  const targetsByRubyOs = new Map<string, PlatformTarget[]>();
  for (const platformTarget of PLATFORMS) {
    const groupedTargets = targetsByRubyOs.get(platformTarget.rubyOs) ?? [];
    groupedTargets.push(platformTarget);
    targetsByRubyOs.set(platformTarget.rubyOs, groupedTargets);
  }

  let platformBlocks = "";
  for (const [rubyOs, platformTargets] of targetsByRubyOs) {
    platformBlocks += `\n  ${rubyOs} do\n`;
    for (const platformTarget of platformTargets) {
      const hash = hashes.get(platformTarget.binaryName);
      if (!hash) {
        fail(`Missing hash for ${platformTarget.binaryName}`);
      }
      platformBlocks += `    ${platformTarget.rubyArch} do\n`;
      platformBlocks += `      url "https://github.com/timescale/memory-engine/releases/download/v#{version}/${platformTarget.binaryName}"\n`;
      platformBlocks += `      sha256 "${hash}"\n`;
      platformBlocks += "    end\n";
    }
    platformBlocks += "  end\n";
  }

  return `class Me < Formula
  desc "Permanent memory for AI agents"
  homepage "https://memory.build"
  version "${version}"
  license "Apache-2.0"
${platformBlocks}
  def install
    binary = Dir.glob("me-*").first
    # Downloaded raw binaries don't have the execute bit set.
    chmod 0755, binary
    if OS.mac?
      system "/usr/bin/xattr", "-cr", binary
    end
    bin.install binary => "me"

    generate_completions_from_executable(bin/"me", "complete")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/me --version")
  end
end
`;
}

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

const token = process.env.HOMEBREW_TAP_GITHUB_TOKEN;
if (!token && !dryRun) {
  fail("HOMEBREW_TAP_GITHUB_TOKEN env var is required (or use --dry-run)");
}

const resolvedBinariesDir = resolve(binariesDir);

console.log(
  `Updating Homebrew formula for me ${version}${dryRun ? " (dry-run)" : ""}`,
);
console.log(`  Binaries: ${resolvedBinariesDir}`);
console.log();

console.log("Computing SHA256 hashes...");
const hashes = new Map<string, string>();
for (const platformTarget of PLATFORMS) {
  const filePath = join(resolvedBinariesDir, platformTarget.binaryName);
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    fail(`Binary not found: ${filePath}`);
  }
  const hash = await sha256(filePath);
  hashes.set(platformTarget.binaryName, hash);
  console.log(`  ${platformTarget.binaryName}: ${hash}`);
}
console.log();

const formula = generateFormula(version, hashes);
console.log("Generated formula:");
console.log(formula);

if (dryRun) {
  console.log("Dry run — not pushing to tap repo.");
  process.exit(0);
}

const tmpDir = join(
  process.env.RUNNER_TEMP || (await import("node:os")).tmpdir(),
  `me-brew-${Date.now()}`,
);

const cloneUrl = `https://x-access-token:${token}@github.com/${TAP_REPO}.git`;
console.log(`Cloning ${TAP_REPO}...`);
await run(["git", "clone", "--depth", "1", cloneUrl, tmpDir]);

const formulaPath = join(tmpDir, FORMULA_FILE);
await Bun.write(formulaPath, formula);

await run(["git", "config", "user.name", "github-actions[bot]"], {
  cwd: tmpDir,
});
await run(
  [
    "git",
    "config",
    "user.email",
    "github-actions[bot]@users.noreply.github.com",
  ],
  { cwd: tmpDir },
);

await run(["git", "add", FORMULA_FILE], { cwd: tmpDir });

const { stdout: diff } = await run(["git", "diff", "--cached", "--name-only"], {
  cwd: tmpDir,
});
if (!diff) {
  console.log("No changes to formula — skipping push.");
  process.exit(0);
}

await run(["git", "commit", "-m", `me ${version}`], { cwd: tmpDir });
await run(["git", "push"], { cwd: tmpDir });

console.log(`Successfully updated ${TAP_REPO}/${FORMULA_FILE} to ${version}.`);
