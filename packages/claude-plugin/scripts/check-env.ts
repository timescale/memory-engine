/**
 * SessionStart hook: verify that `me` CLI is available on PATH.
 * Best-effort -- logs warning to stderr but never blocks session start.
 */

const ME_CLI = "me";

async function main() {
  // Check that `me` is on PATH
  const check = Bun.spawnSync([ME_CLI, "--version"]);
  if (check.exitCode !== 0) {
    console.error(
      `[memory-engine] \`me\` CLI not found on PATH. Install from https://memory.build/install`,
    );
    process.exit(0);
  }

  // Quick connectivity check: try `me memory tree` with minimal scope
  const ping = Bun.spawnSync([ME_CLI, "memory", "tree", "--levels", "1"]);
  if (ping.exitCode !== 0) {
    const stderr = new TextDecoder().decode(ping.stderr);
    console.error(
      `[memory-engine] \`me\` CLI found but engine connection failed: ${stderr.split("\n")[0]}`,
    );
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(`[memory-engine] check-env error: ${err.message}`);
  process.exit(0);
});
