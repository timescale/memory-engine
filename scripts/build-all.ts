// Cross-platform build script — compiles CLI for all targets.
import { $ } from "bun";

const distDir = "dist";

const targets = [
  { target: "bun-linux-x64", suffix: "linux-x64" },
  { target: "bun-linux-arm64", suffix: "linux-arm64" },
  { target: "bun-darwin-arm64", suffix: "darwin-arm64" },
  { target: "bun-windows-x64", suffix: "windows-x64", ext: ".exe" },
];

await $`rm -rf ${distDir}`;
await $`mkdir -p ${distDir}`;

// Build and embed the web UI first. The compile step below imports
// `packages/cli/serve/web-assets.generated.ts`, which is produced by
// `build:web` (Vite build + bundle-web-assets). Without this step a
// fresh checkout fails with "Could not resolve ./web-assets.generated.ts".
console.log("Building embedded web UI...\n");
await $`./bun --cwd=packages/cli run build:web`;

console.log("\nBuilding for all platforms...\n");

await Promise.all(
  targets.map(async ({ target, suffix, ext }) => {
    const output = `me-${suffix}${ext ?? ""}`;
    await $`./bun build --compile --target=${target} ./packages/cli/index.ts --outfile ${distDir}/${output}`;
    console.log(`  done ${output}`);
  }),
);

// macOS: strip Bun's broken signature, re-sign with JIT entitlements, remove quarantine
if (process.platform === "darwin") {
  const entitlements = `${distDir}/.entitlements.plist`;
  await Bun.write(
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
</plist>`,
  );

  for (const { suffix } of targets.filter((t) => t.target.includes("darwin"))) {
    const bin = `${distDir}/me-${suffix}`;
    await $`codesign --remove-signature ${bin}`;
    await $`codesign --entitlements ${entitlements} -f --deep -s - ${bin}`;
    await $`xattr -d com.apple.quarantine ${bin}`.quiet().nothrow();
    console.log(`  signed ${bin}`);
  }

  await $`rm -f ${entitlements}`;
}

console.log("\nBuilt binaries:");
await $`ls -lh ${distDir}/`;
