import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { $ } from "bun";

const repoRoot = path.resolve(import.meta.dir, "..");
const source = path.join(repoRoot, "packages/cli/dist/me");
const installDir = await resolveInstallDir();
const dest = path.join(installDir, "me");

console.log("Building local CLI binary...\n");
await $`./bun run build`.cwd(repoRoot);

await $`mkdir -p ${installDir}`;
await $`cp ${source} ${dest}`;
await $`chmod +x ${dest}`;

if (process.platform === "darwin") {
  const entitlements = path.join(
    repoRoot,
    "packages/cli/dist/.entitlements.plist",
  );
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

  await $`codesign --remove-signature ${dest}`.quiet().nothrow();
  await $`codesign --entitlements ${entitlements} -f --deep -s - ${dest}`
    .quiet()
    .nothrow();
  await $`xattr -d com.apple.quarantine ${dest}`.quiet().nothrow();
  await $`rm -f ${entitlements}`;
}

console.log(`Installed local build to ${dest}`);

const pathEntries = (process.env.PATH ?? "").split(":");
if (!pathEntries.includes(installDir)) {
  console.log(`\nAdd ${installDir} to your PATH:`);
  console.log(`  export PATH="${installDir}:$PATH"`);
}

console.log("\nRun 'me --help' to test the installed local binary.");

async function resolveInstallDir() {
  if (process.env.ME_INSTALL_DIR) {
    return process.env.ME_INSTALL_DIR;
  }

  const localDir = path.join(process.env.HOME ?? "", ".local");
  const localBin = path.join(localDir, "bin");
  if ((await exists(localBin)) || (await exists(localDir))) {
    return localBin;
  }

  return path.join(process.env.HOME ?? "", "bin");
}

async function exists(filePath: string) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
