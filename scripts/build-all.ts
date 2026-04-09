// Cross-platform build script — compiles CLI for all targets.
import { $ } from "bun";

const distDir = "dist";

const targets = [
  { target: "bun-linux-x64", suffix: "linux-x64" },
  { target: "bun-linux-arm64", suffix: "linux-arm64" },
  { target: "bun-darwin-arm64", suffix: "macos-arm64" },
  { target: "bun-windows-x64", suffix: "windows-x64", ext: ".exe" },
];

await $`rm -rf ${distDir}`;
await $`mkdir -p ${distDir}`;

console.log("Building for all platforms...\n");

await Promise.all(
  targets.map(async ({ target, suffix, ext }) => {
    const output = `me-${suffix}${ext ?? ""}`;
    await $`bun build --compile --target=${target} ./packages/cli/index.ts --outfile ${distDir}/${output}`;
    console.log(`  done ${output}`);
  }),
);

console.log("\nBuilt binaries:");
await $`ls -lh ${distDir}/`;
