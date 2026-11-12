#!/usr/bin/env bun

// Generates and publishes the Homebrew formula for the me CLI.
//
// Computes SHA256 hashes of the release binaries, generates the me.rb formula,
// then clones timescale/homebrew-tap, pushes the updated formula to a branch
// and opens a pull request into main.
//
// Usage:
//   ./bun scripts/brew/update-formula.ts --version 0.13.0 --binaries-dir ./binaries [--dry-run]
//
// Requires HOMEBREW_TAP_GITHUB_TOKEN env var for pushing to the tap repo and
// opening the pull request.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const TAP_REPO = "timescale/homebrew-tap";
const TAP_BASE_BRANCH = "main";
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
    fail(
      redact(
        `Command failed (exit ${exitCode}): ${command.join(" ")}\n${stderr}`,
      ),
    );
  }
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// The clone URL contains the token, and git can print it in errors.
function redact(text: string): string {
  return token ? text.replaceAll(token, "***") : text;
}

function tapApi(method: string, path: string, body?: unknown) {
  return fetch(`https://api.github.com/repos/${TAP_REPO}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

// The tap's main branch accepts changes only through a reviewed pull request.
const branch = `me-${version}`;
await run(["git", "switch", "-c", branch], { cwd: tmpDir });
await run(["git", "commit", "-m", `me ${version}`], { cwd: tmpDir });
// Force the push so that a re-run for the same version replaces the branch.
await run(["git", "push", "--force", "origin", branch], { cwd: tmpDir });

const created = await tapApi("POST", "/pulls", {
  title: `me ${version}`,
  head: branch,
  base: TAP_BASE_BRANCH,
  body: `Update the me formula to ${version}.\n\nOpened by the memory-engine release workflow.`,
});
let pullRequestUrl: string | undefined;
if (created.status === 201) {
  pullRequestUrl = ((await created.json()) as { html_url: string }).html_url;
} else if (created.status === 422) {
  // GitHub returns 422 when an open pull request for the branch exists.
  const owner = TAP_REPO.split("/")[0];
  const query = new URLSearchParams({
    state: "open",
    base: TAP_BASE_BRANCH,
    head: `${owner}:${branch}`,
  });
  const found = await tapApi("GET", `/pulls?${query}`);
  if (found.ok) {
    const pulls = (await found.json()) as { html_url: string }[];
    pullRequestUrl = pulls[0]?.html_url;
  }
  if (pullRequestUrl) {
    console.log(`A pull request for ${branch} is already open.`);
  }
}
if (!pullRequestUrl) {
  fail(
    `Could not open pull request (HTTP ${created.status}): ${await created.text()}`,
  );
}

console.log(`Pull request for me ${version}: ${pullRequestUrl}`);
