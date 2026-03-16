/**
 * Postinstall: fix biome binary in Docker sandbox.
 *
 * Bun's workspace install corrupts platform binaries (different hash from
 * cache). In sandbox, we fix this by copying the correct binary from bun's
 * package cache over the broken one in node_modules.
 */

import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

if (process.env.IS_SANDBOX === "1" && process.platform === "linux") {
  const arch = process.arch;
  const pkg = `cli-linux-${arch}`;
  const localBin = join("node_modules", "@biomejs", pkg, "biome");

  // Find the cached binary — bun cache uses @biomejs/<pkg>@<version>@@@<n>
  const cacheDir = join(
    process.env.HOME ?? "/home/agent",
    ".bun",
    "install",
    "cache",
    "@biomejs",
  );

  if (existsSync(cacheDir) && existsSync(localBin)) {
    const entry = readdirSync(cacheDir).find((d) => d.startsWith(`${pkg}@`));
    if (entry) {
      const cacheBin = join(cacheDir, entry, "biome");
      if (existsSync(cacheBin)) {
        copyFileSync(cacheBin, localBin);
        console.log("postinstall: fixed biome binary from bun cache");
      }
    }
  }
}
