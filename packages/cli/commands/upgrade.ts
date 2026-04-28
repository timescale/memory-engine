/**
 * me upgrade — self-update the CLI from the latest GitHub release.
 */

import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { CLIENT_VERSION } from "../../../version";
import { getOutputFormat, output } from "../output.ts";

const REPO = "timescale/memory-engine";
const BINARY = "me";
const MAX_RETRIES = 3;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export type ReleasePlatform = "darwin" | "linux" | "windows";
export type ReleaseArch = "arm64" | "x64";

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, "");
}

export function isVersionGreater(version: string, other: string): boolean {
  return (
    Bun.semver.order(normalizeVersion(version), normalizeVersion(other)) > 0
  );
}

export function detectReleasePlatform(
  platform = process.platform,
): ReleasePlatform {
  switch (platform) {
    case "darwin":
    case "linux":
    case "win32":
      return platform === "win32" ? "windows" : platform;
    default:
      throw new Error(`Unsupported OS: ${platform}`);
  }
}

export function detectReleaseArch(arch = process.arch): ReleaseArch {
  switch (arch) {
    case "arm64":
      return "arm64";
    case "x64":
      return "x64";
    default:
      throw new Error(`Unsupported architecture: ${arch}`);
  }
}

export function releaseAssetName(
  platform: ReleasePlatform,
  arch: ReleaseArch,
): string {
  if (platform === "darwin" && arch === "x64") {
    throw new Error(
      "macOS Intel (x64) is not supported. me requires Apple Silicon (M1+).",
    );
  }

  const asset = `${BINARY}-${platform}-${arch}`;
  return platform === "windows" ? `${asset}.exe` : asset;
}

type UpgradeOptions = {
  check?: boolean;
  force?: boolean;
  version?: string;
};

export function createUpgradeCommand(): Command {
  return new Command("upgrade")
    .description("upgrade the me CLI to the latest release")
    .option(
      "--check",
      "check whether an upgrade is available without installing",
    )
    .option("--force", "reinstall even if the selected version is not newer")
    .option(
      "--version <tag>",
      "install a specific release tag instead of latest",
    )
    .action(async (opts: UpgradeOptions, cmd) => {
      const fmt = getOutputFormat(cmd.optsWithGlobals());
      const currentVersion = CLIENT_VERSION;
      const selectedVersion = opts.version ?? (await fetchLatestVersion());
      const selectedVersionNormalized = normalizeVersion(selectedVersion);
      const isNewer = isVersionGreater(selectedVersion, currentVersion);
      const data = {
        currentVersion,
        latestVersion: selectedVersionNormalized,
        releaseTag: toReleaseTag(selectedVersion),
        upgradeAvailable: isNewer,
        installed: false,
      };

      if (opts.check) {
        await output(data, fmt, () => {
          if (isNewer) {
            clack.log.info(
              `Upgrade available: ${currentVersion} -> ${selectedVersionNormalized}`,
            );
          } else {
            clack.log.success(`me is up to date (${currentVersion}).`);
          }
        });
        return;
      }

      if (!isNewer && !opts.force) {
        await output(data, fmt, () => {
          clack.log.success(`me is up to date (${currentVersion}).`);
        });
        return;
      }

      const installedPath = await installRelease(toReleaseTag(selectedVersion));
      await output({ ...data, installed: true, installedPath }, fmt, () => {
        clack.log.success(
          `Upgraded me ${currentVersion} -> ${selectedVersionNormalized} (${installedPath})`,
        );
      });
    });
}

async function installRelease(tag: string): Promise<string> {
  const executable = process.execPath;
  const executableName = basename(executable).toLowerCase();
  if (executableName !== BINARY && executableName !== `${BINARY}.exe`) {
    throw new Error(
      `Refusing to replace ${executable}. Run an installed '${BINARY}' binary to use '${BINARY} upgrade'.`,
    );
  }

  const platform = detectReleasePlatform();
  const arch = detectReleaseArch();
  const asset = releaseAssetName(platform, arch);

  if (platform === "windows") {
    throw new Error(
      "Self-upgrade is not supported on Windows yet. Please rerun install.sh.",
    );
  }

  await access(executable, constants.W_OK).catch(() => {
    throw new Error(
      `Cannot write to ${executable}. Reinstall with install.sh or run with sufficient permissions.`,
    );
  });

  const installDir = dirname(executable);
  const tempDir = await mkdtemp(join(installDir, `.${BINARY}-upgrade-`));
  const tempBinary = join(tempDir, asset);
  const tempChecksum = `${tempBinary}.sha256`;

  try {
    const binaryUrl = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
    const checksumUrl = `${binaryUrl}.sha256`;

    await downloadWithRetry(binaryUrl, tempBinary);
    await downloadWithRetry(checksumUrl, tempChecksum);

    clack.log.info("Verifying checksum...");
    await verifyChecksum(tempBinary, tempChecksum);
    await chmod(tempBinary, 0o755);

    if (platform === "darwin") {
      await signMacBinary(tempBinary);
    }

    await rename(tempBinary, executable);
    return executable;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function fetchLatestVersion(): Promise<string> {
  const response = await fetch(`https://github.com/${REPO}/releases/latest`);
  if (!response.ok) {
    throw new Error(
      `Failed to determine latest version: HTTP ${response.status}`,
    );
  }

  const version = response.url.split("/").pop();
  if (!version) {
    throw new Error("Failed to determine latest version");
  }

  return version;
}

function toReleaseTag(version: string): string {
  const trimmed = version.trim();
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

async function downloadWithRetry(
  url: string,
  outputPath: string,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await download(url, outputPath);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        const delayMs = attempt * attempt * 1000;
        clack.log.warn(
          `Download failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delayMs / 1000}s...`,
        );
        await Bun.sleep(delayMs);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Download failed after ${MAX_RETRIES} attempts: ${url}`);
}

async function download(url: string, outputPath: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Download failed (${response.status}): ${url}`);
    }
    if (!response.body) {
      throw new Error(`Download failed: empty response body: ${url}`);
    }

    const contentLength = response.headers.get("content-length");
    const parsedTotalBytes = contentLength ? Number(contentLength) : undefined;
    const totalBytes =
      parsedTotalBytes &&
      Number.isFinite(parsedTotalBytes) &&
      parsedTotalBytes > 0
        ? parsedTotalBytes
        : undefined;
    const file = Bun.file(outputPath).writer();
    const reader = response.body.getReader();
    const label = downloadLabel(url);
    const progress = clack.progress({ max: totalBytes ?? 1 });
    let downloadedBytes = 0;
    let lastProgress = 0;
    let completed = false;

    progress.start(`Downloading ${label}`);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        downloadedBytes += value.byteLength;
        file.write(value);

        if (totalBytes) {
          progress.advance(
            value.byteLength,
            downloadProgressMessage(downloadedBytes, totalBytes),
          );
        } else if (Date.now() - lastProgress > 1_000) {
          lastProgress = Date.now();
          progress.message(
            `Downloading ${label} (${formatBytes(downloadedBytes)})`,
          );
        }
      }

      if (!totalBytes) {
        progress.advance(1, `Downloaded ${formatBytes(downloadedBytes)}`);
      }
      completed = true;
    } finally {
      await file.end();
      if (completed) {
        progress.stop(`Downloaded ${label}`);
      } else {
        progress.error(`Failed to download ${label}`);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s: ${url}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function downloadProgressMessage(
  downloadedBytes: number,
  totalBytes: number,
): string {
  const percent = Math.floor((downloadedBytes / totalBytes) * 100);
  return `Downloading ${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)} (${percent}%)`;
}

function downloadLabel(url: string): string {
  const pathname = new URL(url).pathname;
  return pathname.split("/").pop() || url;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function verifyChecksum(
  file: string,
  checksumFile: string,
): Promise<void> {
  const expected = (await Bun.file(checksumFile).text()).trim().split(/\s+/)[0];
  const actual = await sha256(file);

  if (!expected || expected !== actual) {
    throw new Error(
      `Checksum mismatch!\n  Expected: ${expected}\n  Actual:   ${actual}`,
    );
  }

  clack.log.success("Checksum verified");
}

async function sha256(file: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(file).arrayBuffer());
  return hasher.digest("hex");
}

async function signMacBinary(file: string): Promise<void> {
  const entitlements = `${file}.entitlements.plist`;
  await writeFile(
    entitlements,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-executable-page-protection</key>
    <true/>
    <key>com.apple.security.cs.allow-dyld-environment-variables</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
</dict>
</plist>
`,
  );

  try {
    await run(["codesign", "--remove-signature", file], true);
    await run(
      [
        "codesign",
        "--entitlements",
        entitlements,
        "-f",
        "--deep",
        "-s",
        "-",
        file,
      ],
      true,
    );
    await run(["xattr", "-d", "com.apple.quarantine", file], true);
  } finally {
    await rm(entitlements, { force: true });
  }
}

async function run(args: string[], ignoreFailure = false): Promise<void> {
  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  const exitCode = await proc.exited;
  if (exitCode !== 0 && !ignoreFailure) {
    throw new Error(`Command failed: ${args.join(" ")}`);
  }
}
