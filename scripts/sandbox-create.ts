// Creates a Docker sandbox with the `me` CLI and MCP server pre-configured.
//
// Prerequisites:
//   1. Build the sandbox image: bun run sandbox:build
//   2. Build the me binary:     bun run build:all
//
// Usage:
//   bun scripts/sandbox-create.ts --binary dist/me-linux-arm64 --api-key <key> <sandbox-path>
//
// The sandbox-path directory is mounted at the same path inside the sandbox.
// The script creates the sandbox, installs the me binary, writes a .mcp.json
// for Claude's MCP integration, and sets ME_SERVER/ME_API_KEY env vars so the
// `me` CLI works from the shell.

import { copyFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { $ } from "bun";

// Parse args
let binary: string | undefined;
let apiKey: string | undefined;
let sandboxPath: string | undefined;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--binary") {
    binary = args[++i];
  } else if (args[i] === "--api-key") {
    apiKey = args[++i];
  } else if (args[i]?.startsWith("--") !== true) {
    sandboxPath = args[i];
  }
}

if (!binary || !apiKey || !sandboxPath) {
  console.error(
    "Usage: bun run sandbox:create -- --binary <path> --api-key <key> <sandbox-path>",
  );
  process.exit(1);
}

sandboxPath = resolve(sandboxPath);
const name = basename(sandboxPath);
const binaryFilename = basename(binary);

// 1. Copy binary into sandbox filesystem (skip if already there)
const binaryDest = `${sandboxPath}/${binaryFilename}`;
if (resolve(binary) === binaryDest) {
  console.log(`Binary already at ${binaryDest}, skipping copy`);
} else {
  console.log(`Copying ${binary} → ${binaryDest}`);
  copyFileSync(binary, binaryDest);
}

// 2. Create sandbox
console.log(`Creating sandbox "${name}"...`);
await $`docker sandbox create --name ${name} -t "me-sandbox:claude" claude ${sandboxPath}`;

// 3. Allow network access to local server
console.log("Configuring network proxy...");
await $`docker sandbox network proxy ${name} --allow-host localhost:3000`;

// 4. Move binary into PATH
console.log("Installing me binary...");
await $`docker sandbox exec ${name} sh -c ${`cp ${sandboxPath}/${binaryFilename} /home/agent/.local/bin/me && chmod +x /home/agent/.local/bin/me`}`;

// 5. Write .mcp.json into the sandbox workspace
console.log("Writing .mcp.json...");
const mcpConfig = {
  mcpServers: {
    me: {
      command: "/home/agent/.local/bin/me",
      args: ["mcp"],
      env: {
        ME_SERVER: "http://host.docker.internal:3000",
        ME_API_KEY: apiKey,
      },
    },
  },
};
await Bun.write(
  `${sandboxPath}/.mcp.json`,
  `${JSON.stringify(mcpConfig, null, 2)}\n`,
);

// 6. Set environment variables for CLI usage
console.log("Setting environment variables...");
await $`docker sandbox exec ${name} sh -c ${"echo 'export ME_SERVER=\"http://host.docker.internal:3000\"' >> /etc/sandbox-persistent.sh"}`;
await $`docker sandbox exec ${name} sh -c ${`echo 'export ME_API_KEY="${apiKey}"' >> /etc/sandbox-persistent.sh`}`;

console.log(`\nSandbox "${name}" is ready.`);
