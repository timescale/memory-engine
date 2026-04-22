#!/usr/bin/env node

// This script is the entry point for the @memory.build/cli npm package.
// It resolves and spawns the correct platform-specific binary from
// the @memory.build/cli-{os}-{arch} optional dependency packages.

const { platform, arch, env, argv } = process;
const { spawnSync } = require("node:child_process");

const PLATFORMS = {
  darwin: {
    arm64: "@memory.build/cli-darwin-arm64/bin/me",
  },
  linux: {
    x64: "@memory.build/cli-linux-x64/bin/me",
    arm64: "@memory.build/cli-linux-arm64/bin/me",
  },
};

const binPath = env.ME_BINARY || PLATFORMS[platform]?.[arch];

if (!binPath) {
  console.error(
    `me does not ship prebuilt binaries for your platform (${platform}-${arch}).`,
  );
  console.error(
    "You can install from source instead: https://github.com/timescale/memory-engine",
  );
  process.exitCode = 1;
} else {
  let resolvedPath;
  try {
    resolvedPath = env.ME_BINARY || require.resolve(binPath);
  } catch {
    console.error(
      `Could not find the me binary for your platform (${platform}-${arch}).`,
    );
    console.error(
      "The platform-specific package may not have been installed correctly.",
    );
    console.error("Try reinstalling: npm install -g @memory.build/cli");
    process.exitCode = 1;
  }

  if (resolvedPath) {
    const result = spawnSync(resolvedPath, argv.slice(2), {
      shell: false,
      stdio: "inherit",
    });

    if (result.error) {
      throw result.error;
    }

    if (result.signal) {
      if (platform === "darwin" && result.signal === "SIGKILL") {
        console.error(
          "The me binary was killed by macOS before it could start.",
        );
        console.error(
          "This usually means the darwin binary is not code-signed correctly.",
        );
      } else {
        console.error(`The me binary exited due to signal ${result.signal}.`);
      }
      process.exitCode = 1;
    } else {
      process.exitCode = result.status ?? 1;
    }
  }
}
