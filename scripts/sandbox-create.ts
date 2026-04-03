// Creates a Docker sandbox with the specified agent, installs tools,
// configures MCP for Memory Engine, and sets environment variables.
//
// Prerequisites:
//   Build the me binary: bun run build:all
//
// Usage:
//   bun scripts/sandbox-create.ts <agent> <path> --binary <path> --api-key <key>
//
// Agents: claude, opencode, gemini, codex
//
// Example:
//   bun scripts/sandbox-create.ts claude ~/projects/myapp --binary dist/me-linux-arm64 --api-key sk-xxx
//
// The sandbox-path directory is mounted at the same path inside the sandbox.
// After creation, run: sbx run <sandbox-name>

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { $ } from "bun";

const SUPPORTED_AGENTS = ["claude", "opencode", "gemini", "codex"] as const;
type Agent = (typeof SUPPORTED_AGENTS)[number];

const BUN_VERSION = "bun-v1.3.10";

// Parse arguments
let agent: Agent | undefined;
let sandboxPath: string | undefined;
let binary: string | undefined;
let apiKey: string | undefined;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--binary") {
    binary = args[++i];
  } else if (arg === "--api-key") {
    apiKey = args[++i];
  } else if (!arg?.startsWith("--")) {
    if (!agent) {
      if (!SUPPORTED_AGENTS.includes(arg as Agent)) {
        console.error(`Invalid agent: ${arg}`);
        console.error(`Supported agents: ${SUPPORTED_AGENTS.join(", ")}`);
        process.exit(1);
      }
      agent = arg as Agent;
    } else if (!sandboxPath) {
      sandboxPath = arg;
    }
  }
}

if (!agent || !sandboxPath || !binary || !apiKey) {
  console.error(
    "Usage: bun scripts/sandbox-create.ts <agent> <path> --binary <path> --api-key <key>",
  );
  console.error(`Supported agents: ${SUPPORTED_AGENTS.join(", ")}`);
  process.exit(1);
}

sandboxPath = resolve(sandboxPath);
const sandboxName = `${agent}-${basename(sandboxPath)}`;
const binaryFilename = basename(binary);
const scriptDir = dirname(new URL(import.meta.url).pathname);

console.log(`Creating ${agent} sandbox: ${sandboxName}`);
console.log(`  Path: ${sandboxPath}`);
console.log(`  Binary: ${binary}`);

// Ensure sandbox path exists
if (!existsSync(sandboxPath)) {
  console.log(`Creating directory: ${sandboxPath}`);
  mkdirSync(sandboxPath, { recursive: true });
}

// 1. Create the sandbox
console.log("\n[1/8] Creating sandbox...");
await $`sbx create ${agent} ${sandboxPath} --name ${sandboxName}`;

// Helper to run commands in the sandbox
async function sbxExec(cmd: string, asRoot = false) {
  if (asRoot) {
    await $`sbx exec ${sandboxName} sudo sh -c ${cmd}`;
  } else {
    await $`sbx exec ${sandboxName} sh -c ${cmd}`;
  }
}

// Helper to wait for apt lock to be released (sandbox may be running apt in background)
async function waitForAptLock(timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Try to acquire the lock briefly - if it succeeds, apt is available
      await $`sbx exec ${sandboxName} sudo flock -n /var/lib/apt/lists/lock -c "exit 0"`.quiet();
      return;
    } catch {
      // Lock is held, wait and retry
      await Bun.sleep(2000);
    }
  }
  throw new Error("Timed out waiting for apt lock to be released");
}

// 2. Install Bun
console.log("\n[2/8] Installing Bun...");
await sbxExec(`curl -fsSL https://bun.sh/install | bash -s "${BUN_VERSION}"`);
// Add bun to PATH for this session and persistently
await sbxExec(
  "echo 'export BUN_INSTALL=\"$HOME/.bun\"' >> /etc/sandbox-persistent.sh",
  true,
);
await sbxExec(
  "echo 'export PATH=\"$BUN_INSTALL/bin:$PATH\"' >> /etc/sandbox-persistent.sh",
  true,
);

// 3. Install apt packages
console.log("\n[3/8] Installing system packages...");
// Wait for any background apt processes to finish (sandbox may run apt-get update on start)
await waitForAptLock();
await sbxExec(
  "apt-get update && apt-get install -y --no-install-recommends vim wget curl tree jq ripgrep gh sqlite3 lua5.4 postgresql-client && rm -rf /var/lib/apt/lists/*",
  true,
);

// 4. Install yq
console.log("\n[4/8] Installing yq...");
await sbxExec(
  'ARCH="$(dpkg --print-architecture)" && wget "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${ARCH}" -O /usr/local/bin/yq && chmod +x /usr/local/bin/yq',
  true,
);

// 6. Install ghostty terminfo
console.log("\n[6/8] Installing ghostty terminfo...");
const terminfoSrc = resolve(scriptDir, "ghostty.terminfo");
const terminfoDest = `${sandboxPath}/.ghostty.terminfo`;
copyFileSync(terminfoSrc, terminfoDest);
await sbxExec(
  `tic -x ${sandboxPath}/.ghostty.terminfo && rm ${sandboxPath}/.ghostty.terminfo`,
  true,
);

// 7. Install ME binary
console.log("\n[7/8] Installing ME binary...");
const binaryDest = `${sandboxPath}/${binaryFilename}`;
if (resolve(binary) !== binaryDest) {
  copyFileSync(binary, binaryDest);
}
await sbxExec(
  `mkdir -p /home/agent/.local/bin && cp ${sandboxPath}/${binaryFilename} /home/agent/.local/bin/me && chmod +x /home/agent/.local/bin/me`,
);
// Clean up binary from workspace
await sbxExec(`rm -f ${sandboxPath}/${binaryFilename}`);

// 8. Configure MCP and environment
console.log("\n[8/8] Configuring MCP and environment...");

const meServer = "http://host.docker.internal:3000";

// Write agent-specific MCP config
switch (agent) {
  case "claude": {
    const mcpConfig = {
      mcpServers: {
        me: {
          command: "/home/agent/.local/bin/me",
          args: ["mcp"],
          env: {
            ME_SERVER: meServer,
            ME_API_KEY: apiKey,
          },
        },
      },
    };
    await Bun.write(
      `${sandboxPath}/.mcp.json`,
      `${JSON.stringify(mcpConfig, null, 2)}\n`,
    );
    break;
  }

  case "opencode": {
    const mcpConfig = {
      mcp: {
        me: {
          type: "local",
          command: ["/home/agent/.local/bin/me", "mcp"],
          environment: {
            ME_SERVER: meServer,
            ME_API_KEY: apiKey,
          },
        },
      },
    };
    await Bun.write(
      `${sandboxPath}/opencode.json`,
      `${JSON.stringify(mcpConfig, null, 2)}\n`,
    );
    break;
  }

  case "gemini": {
    const mcpConfig = {
      mcpServers: {
        me: {
          command: "/home/agent/.local/bin/me",
          args: ["mcp"],
          env: {
            ME_SERVER: meServer,
            ME_API_KEY: apiKey,
          },
        },
      },
    };
    // Gemini uses ~/.gemini/settings.json
    await sbxExec("mkdir -p /home/agent/.gemini");
    // Write to sandbox path first, then move
    const geminiConfigPath = `${sandboxPath}/.gemini-settings.json`;
    await Bun.write(
      geminiConfigPath,
      `${JSON.stringify(mcpConfig, null, 2)}\n`,
    );
    await sbxExec(
      `cp ${sandboxPath}/.gemini-settings.json /home/agent/.gemini/settings.json && rm ${sandboxPath}/.gemini-settings.json`,
    );
    break;
  }

  case "codex": {
    // Codex uses TOML format
    const tomlContent = `[mcp_servers.me]
command = "/home/agent/.local/bin/me"
args = ["mcp"]

[mcp_servers.me.env]
ME_SERVER = "${meServer}"
ME_API_KEY = "${apiKey}"
`;
    // Write to .codex/config.toml in the workspace
    mkdirSync(`${sandboxPath}/.codex`, { recursive: true });
    await Bun.write(`${sandboxPath}/.codex/config.toml`, tomlContent);
    break;
  }
}

// Set environment variables for CLI usage (all agents)
await sbxExec(
  `echo 'export ME_SERVER="${meServer}"' >> /etc/sandbox-persistent.sh`,
  true,
);
await sbxExec(
  `echo 'export ME_API_KEY="${apiKey}"' >> /etc/sandbox-persistent.sh`,
  true,
);

// Configure network policy to allow access to local ME server
console.log("\nConfiguring network policy...");
await $`sbx policy allow network localhost:3000`;

console.log(`
Sandbox "${sandboxName}" is ready.

Run with:
  sbx run ${sandboxName}

MCP configured for: ${agent}
ME server: ${meServer}
`);
