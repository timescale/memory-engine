/**
 * me claude — Claude Code integration commands.
 *
 * - me claude install:   install Memory Engine plugin for Claude Code
 * - me claude uninstall: remove plugin (Phase 4)
 * - me claude hook:      invoked by plugin hooks (Phase 3)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import {
  createAccountsClient,
  createAuthClient,
  createClient,
  DeviceFlowError,
} from "@memory.build/client";
import { Command } from "commander";
import { parse, stringify } from "yaml";
import { CLIENT_VERSION } from "../../../version";
import {
  getEngineApiKey,
  getServerCredentials,
  resolveServer,
  storeSessionToken,
} from "../credentials.ts";

// =============================================================================
// Constants
// =============================================================================

const PLUGIN_DIR = join(homedir(), ".claude", "plugins", "memory-engine");
const CONFIG_PATH = join(PLUGIN_DIR, "config.yaml");
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

// =============================================================================
// Helpers
// =============================================================================

/**
 * Attempt to open a URL in the user's default browser.
 * Fails silently — the user can always visit the URL manually.
 */
async function openBrowser(url: string): Promise<void> {
  try {
    const cmds: Record<string, string[]> = {
      darwin: ["open", url],
      linux: ["xdg-open", url],
      win32: ["cmd", "/c", "start", url],
    };
    const args = cmds[process.platform];
    if (args) {
      const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
      await proc.exited;
    }
  } catch {
    // Ignore — user will see the URL in the terminal
  }
}

/** Mask an API key for display: "me.abc***.***" */
function maskApiKey(key: string): string {
  if (key.length <= 8) return "***";
  return `${key.slice(0, 6)}***.***`;
}

/** Format a date as a human-readable relative time string. */
function relativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// =============================================================================
// Inline Login (OAuth device flow, called directly from wizard)
// =============================================================================

/**
 * Run the OAuth device flow inline and return the session token.
 * Stores the token in the credentials file as a side effect.
 */
async function performInlineLogin(server: string): Promise<string> {
  const auth = createAuthClient({ url: server });

  const spin = clack.spinner();
  spin.start("Starting login...");

  let flow: Awaited<ReturnType<typeof auth.startDeviceFlow>>;
  try {
    flow = await auth.startDeviceFlow("github");
  } catch (error) {
    spin.stop("Failed to start login.");
    const msg = error instanceof Error ? error.message : String(error);
    clack.log.error(msg);
    clack.outro("Login failed.");
    process.exit(1);
  }

  spin.stop("Login started.");

  clack.note(
    `Code: ${flow.userCode}\nURL:  ${flow.verificationUri}`,
    "Enter this code in your browser",
  );

  await openBrowser(flow.verificationUri);

  const pollSpin = clack.spinner();
  pollSpin.start("Waiting for authorization...");

  try {
    const result = await auth.pollForToken(flow.deviceCode, {
      interval: flow.interval,
      expiresIn: flow.expiresIn,
    });
    pollSpin.stop("Authorized!");
    storeSessionToken(server, result.sessionToken);
    clack.log.success(
      `Logged in as ${result.identity.name} (${result.identity.email})`,
    );
    return result.sessionToken;
  } catch (error) {
    pollSpin.stop("Authorization failed.");
    const msg =
      error instanceof DeviceFlowError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    clack.log.error(msg);
    clack.outro("Login failed.");
    process.exit(1);
  }
}

// =============================================================================
// API Key Validation
// =============================================================================

/** Validate an API key by calling memory.tree against the engine. */
async function validateApiKey(
  server: string,
  apiKey: string,
): Promise<boolean> {
  try {
    const client = createClient({ url: server, apiKey });
    await client.memory.tree({ levels: 1 });
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Uninstall subroutine (used by Step 3 and future `me claude uninstall`)
// =============================================================================

/** Remove the plugin directory and disable in settings.json. */
function uninstallPlugin(): void {
  if (existsSync(PLUGIN_DIR)) {
    rmSync(PLUGIN_DIR, { recursive: true });
  }

  if (existsSync(SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      if (
        settings.enabledPlugins &&
        typeof settings.enabledPlugins === "object"
      ) {
        delete (settings.enabledPlugins as Record<string, unknown>)[
          "memory-engine"
        ];
        writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
      }
    } catch {
      // Ignore — settings file may be malformed
    }
  }
}

// =============================================================================
// File Writing
// =============================================================================

interface WizardConfig {
  server: string;
  orgName: string;
  orgSlug: string;
  engineSlug: string;
  apiKey: string;
  mode: "plugin" | "mcp-only";
  treePrefix: string;
}

/** Write all plugin files to ~/.claude/plugins/memory-engine/. */
function writePluginFiles(config: WizardConfig): void {
  const now = new Date().toISOString();

  // Create directories
  mkdirSync(join(PLUGIN_DIR, ".claude-plugin"), { recursive: true });
  if (config.mode === "plugin") {
    mkdirSync(join(PLUGIN_DIR, "hooks"), { recursive: true });
  }

  // config.yaml (chmod 0600 — contains API key)
  const configContent = stringify(
    {
      server: config.server,
      engine: config.engineSlug,
      api_key: config.apiKey,
      tree_prefix: config.treePrefix,
      mode: config.mode,
      installed_at: now,
      installed_by: CLIENT_VERSION,
    },
    { lineWidth: 0 },
  );
  writeFileSync(CONFIG_PATH, configContent, { mode: 0o600 });

  // .claude-plugin/plugin.json
  writeFileSync(
    join(PLUGIN_DIR, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: "memory-engine",
        version: CLIENT_VERSION,
        description: "Memory Engine integration for Claude Code",
        author: { name: "Timescale" },
        homepage: "https://memory.build",
        license: "Apache-2.0",
      },
      null,
      2,
    )}\n`,
  );

  // hooks/hooks.json (plugin mode only — calls `me claude hook`)
  if (config.mode === "plugin") {
    const hookCmd = (event: string) =>
      `me claude hook --event ${event} --plugin-dir "\${CLAUDE_PLUGIN_ROOT}"`;

    writeFileSync(
      join(PLUGIN_DIR, "hooks", "hooks.json"),
      `${JSON.stringify(
        {
          description: "Memory Engine capture hooks",
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: "command",
                    command: hookCmd("user-prompt-submit"),
                    async: true,
                    timeout: 30,
                  },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command: hookCmd("stop"),
                    async: true,
                    timeout: 30,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
  }

  // .mcp.json (API key + server baked at install time)
  writeFileSync(
    join(PLUGIN_DIR, ".mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          me: {
            command: "me",
            args: [
              "mcp",
              "--api-key",
              config.apiKey,
              "--server",
              config.server,
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  // .gitignore (protect config.yaml from accidental commits)
  writeFileSync(join(PLUGIN_DIR, ".gitignore"), "config.yaml\n");

  // README.md
  writeFileSync(
    join(PLUGIN_DIR, "README.md"),
    [
      "# Memory Engine Claude Code Plugin",
      "",
      `Installed by \`me claude install\` on ${now}.`,
      "",
      "Configuration in `config.yaml` (contains API key, mode 0600).",
      "",
      "## Managing",
      "",
      "- Uninstall:  me claude uninstall",
      "- Reinstall:  me claude uninstall && me claude install",
      '- Verify:     me memory search --tree "claude_code.*" --limit 5',
      "",
      "## Links",
      "",
      "- Memory Engine: https://memory.build",
      "- Docs: https://docs.memory.build",
      "",
    ].join("\n"),
  );
}

/** Add "memory-engine": true to ~/.claude/settings.json enabledPlugins. */
function updateClaudeSettings(): void {
  let settings: Record<string, unknown> = {};

  if (existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    } catch {
      // Start fresh if malformed
    }
  } else {
    // Ensure ~/.claude/ directory exists
    const claudeDir = join(homedir(), ".claude");
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }
  }

  if (!settings.enabledPlugins || typeof settings.enabledPlugins !== "object") {
    settings.enabledPlugins = {};
  }
  (settings.enabledPlugins as Record<string, boolean>)["memory-engine"] = true;

  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

// =============================================================================
// Wizard
// =============================================================================

async function runClaudeInstallWizard(opts: {
  server?: string;
  apiKey?: string;
}): Promise<void> {
  clack.intro("me claude install");

  // ── Step 1: Resolve server ──────────────────────────────────────────
  const server = resolveServer(opts.server);
  clack.log.info(`Server: ${server}`);

  // ── Step 2: Login check ─────────────────────────────────────────────
  let sessionToken =
    process.env.ME_SESSION_TOKEN ?? getServerCredentials(server).session_token;

  if (!sessionToken) {
    clack.log.warn("Not logged in. Starting login...");
    sessionToken = await performInlineLogin(server);
  }

  // ── Step 3: Existing install detection ──────────────────────────────
  if (existsSync(CONFIG_PATH)) {
    try {
      const existing = parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<
        string,
        string
      >;
      const installedAt = existing.installed_at
        ? relativeTime(new Date(existing.installed_at))
        : "unknown";
      const installedBy = existing.installed_by ?? "unknown";

      clack.log.warn("A Memory Engine plugin is already installed.");
      clack.log.info(`  Engine:       ${existing.engine ?? "unknown"}`);
      clack.log.info(`  Tree prefix:  ${existing.tree_prefix ?? "unknown"}`);
      clack.log.info(`  Installed:    ${installedAt} (me v${installedBy})`);

      const proceed = await clack.confirm({
        message: "Uninstall and continue?",
        initialValue: false,
      });
      if (clack.isCancel(proceed) || !proceed) {
        clack.log.info("Run `me claude uninstall` to remove.");
        clack.outro("");
        process.exit(0);
      }

      uninstallPlugin();
      clack.log.success("Previous installation removed.");
    } catch {
      // Corrupted config — remove silently and continue as fresh install
      uninstallPlugin();
    }
  }

  // ── Step 4: Org selection ───────────────────────────────────────────
  const accounts = createAccountsClient({ url: server, sessionToken });

  let orgs: Array<{ id: string; slug: string; name: string }>;
  try {
    const result = await accounts.org.list();
    orgs = result.orgs;
  } catch (error) {
    clack.log.error(
      `Failed to list organizations: ${error instanceof Error ? error.message : String(error)}`,
    );
    clack.outro("Try running `me login` and re-running this command.");
    process.exit(1);
  }

  if (orgs.length === 0) {
    clack.log.error("No organizations found.");
    clack.outro("Create an organization first.");
    process.exit(1);
  }

  let org: { id: string; slug: string; name: string };
  if (orgs.length === 1 && orgs[0]) {
    org = orgs[0];
    clack.log.info(`Org: ${org.name} (${org.slug})`);
  } else {
    const selected = await clack.select({
      message: "Select an organization",
      options: orgs.map((o) => ({
        value: o.id,
        label: o.name,
        hint: o.slug,
      })),
    });
    if (clack.isCancel(selected)) {
      clack.cancel("Cancelled.");
      process.exit(0);
    }
    const found = orgs.find((o) => o.id === (selected as string));
    if (!found) {
      clack.log.error("Organization not found.");
      process.exit(1);
    }
    org = found;
  }

  // ── Step 5: Engine selection ────────────────────────────────────────
  let allEngines: Array<{
    id: string;
    slug: string;
    name: string;
    status: string;
  }>;
  try {
    const result = await accounts.engine.list({ orgId: org.id });
    allEngines = result.engines;
  } catch (error) {
    clack.log.error(
      `Failed to list engines: ${error instanceof Error ? error.message : String(error)}`,
    );
    clack.outro("");
    process.exit(1);
  }

  const engines = allEngines.filter((e) => e.status === "active");

  if (engines.length === 0) {
    clack.log.error(
      "No engines found. Create one with `me engine create` and re-run.",
    );
    clack.outro("");
    process.exit(1);
  }

  let engine: { id: string; slug: string; name: string };
  if (engines.length === 1 && engines[0]) {
    engine = engines[0];
    clack.log.info(`Engine: ${engine.name} (${engine.slug})`);
  } else {
    // Default to active engine from credentials if it belongs to this org
    const activeEngineSlug = getServerCredentials(server).active_engine;
    const defaultEngine = engines.find((e) => e.slug === activeEngineSlug);

    const selected = await clack.select({
      message: "Select an engine",
      initialValue: defaultEngine?.id,
      options: engines.map((e) => ({
        value: e.id,
        label: e.name,
        hint: e.slug,
      })),
    });
    if (clack.isCancel(selected)) {
      clack.cancel("Cancelled.");
      process.exit(0);
    }
    const found = engines.find((e) => e.id === (selected as string));
    if (!found) {
      clack.log.error("Engine not found.");
      process.exit(1);
    }
    engine = found;
  }

  // ── Step 6: API key ────────────────────────────────────────────────
  let apiKey: string;

  if (opts.apiKey) {
    // Pre-provided via --api-key flag
    apiKey = opts.apiKey;
  } else {
    const existingKey = getEngineApiKey(server, engine.slug);

    if (existingKey) {
      const source = await clack.select({
        message: "Choose API key",
        options: [
          { value: "existing", label: "Use existing key from credentials" },
          { value: "paste", label: "Paste an existing API key" },
        ],
      });
      if (clack.isCancel(source)) {
        clack.cancel("Cancelled.");
        process.exit(0);
      }

      if ((source as string) === "existing") {
        apiKey = existingKey;
      } else {
        const pasted = await clack.password({ message: "Paste your API key" });
        if (clack.isCancel(pasted)) {
          clack.cancel("Cancelled.");
          process.exit(0);
        }
        apiKey = pasted;
      }
    } else {
      const pasted = await clack.password({ message: "Paste your API key" });
      if (clack.isCancel(pasted)) {
        clack.cancel("Cancelled.");
        process.exit(0);
      }
      apiKey = pasted;
    }
  }

  // Validate API key against the engine
  const validSpin = clack.spinner();
  validSpin.start("Validating API key...");
  const valid = await validateApiKey(server, apiKey);
  if (!valid) {
    validSpin.stop("API key validation failed.");
    clack.log.error("This key doesn't work for this engine.");
    clack.outro("Check the key and try again.");
    process.exit(1);
  }
  validSpin.stop(`API key valid (${maskApiKey(apiKey)})`);

  // ── Step 7: Mode ───────────────────────────────────────────────────
  const modeResult = await clack.select({
    message: "What to install",
    options: [
      { value: "plugin", label: "MCP server + plugin (recommended)" },
      { value: "mcp-only", label: "MCP server only" },
    ],
  });
  if (clack.isCancel(modeResult)) {
    clack.cancel("Cancelled.");
    process.exit(0);
  }
  const mode = modeResult as "plugin" | "mcp-only";

  // ── Step 8: Tree prefix (plugin mode only) ─────────────────────────
  let treePrefix = "claude_code.sessions";
  if (mode === "plugin") {
    const input = await clack.text({
      message: "Tree prefix for captured memories",
      defaultValue: "claude_code.sessions",
      initialValue: "claude_code.sessions",
      validate: (value) => {
        if (!/^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(value)) {
          return "Invalid ltree path. Use lowercase letters, numbers, underscores, separated by dots.";
        }
      },
    });
    if (clack.isCancel(input)) {
      clack.cancel("Cancelled.");
      process.exit(0);
    }
    treePrefix = input;
  }

  // ── Step 9: Confirmation ────────────────────────────────────────────
  const summaryLines = [
    `Server:       ${server}`,
    `Org:          ${org.name} (${org.slug})`,
    `Engine:       ${engine.slug}`,
    `API key:      ${maskApiKey(apiKey)} (valid)`,
    `Mode:         ${mode === "plugin" ? "MCP server + plugin" : "MCP server only"}`,
    ...(mode === "plugin" ? [`Tree prefix:  ${treePrefix}`] : []),
    `Scope:        user`,
    "",
    "Will write to:",
    "  ~/.claude/plugins/memory-engine/",
    "  ~/.claude/settings.json",
  ];

  clack.note(summaryLines.join("\n"), "Ready to install");

  const confirmed = await clack.confirm({
    message: "Proceed?",
    initialValue: true,
  });
  if (clack.isCancel(confirmed) || !confirmed) {
    clack.cancel("Cancelled.");
    process.exit(0);
  }

  // ── Step 10: Write files ────────────────────────────────────────────
  const writeSpin = clack.spinner();
  writeSpin.start("Writing plugin files...");

  try {
    writePluginFiles({
      server,
      orgName: org.name,
      orgSlug: org.slug,
      engineSlug: engine.slug,
      apiKey,
      mode,
      treePrefix,
    });
    updateClaudeSettings();
    writeSpin.stop("Plugin files written.");
  } catch (error) {
    writeSpin.stop("Failed to write plugin files.");
    clack.log.error(error instanceof Error ? error.message : String(error));
    clack.outro("Try again or check file permissions.");
    process.exit(1);
  }

  // ── Step 11: Success + next steps ──────────────────────────────────
  clack.log.success("Plugin installed at ~/.claude/plugins/memory-engine/");
  clack.log.success("Plugin enabled in ~/.claude/settings.json");
  clack.log.info(
    [
      "",
      "Next steps:",
      "  1. Restart Claude Code or run /reload-plugins in an active session",
      "  2. Verify captures:",
      `       me memory search --tree "${treePrefix}.*" --limit 5`,
      "",
      "To uninstall: me claude uninstall",
    ].join("\n"),
  );
  clack.outro("Done!");
}

// =============================================================================
// Commands
// =============================================================================

function createClaudeInstallCommand(): Command {
  return new Command("install")
    .description("install Memory Engine plugin for Claude Code")
    .option("--server <url>", "server URL")
    .option("--api-key <key>", "API key (skips interactive key selection)")
    .action(
      async (opts: { server?: string; apiKey?: string }, cmd: Command) => {
        const globalOpts = cmd.optsWithGlobals();
        await runClaudeInstallWizard({
          server: globalOpts.server ?? opts.server,
          apiKey: opts.apiKey,
        });
      },
    );
}

export function createClaudeCommand(): Command {
  const claude = new Command("claude").description("Claude Code integration");
  claude.addCommand(createClaudeInstallCommand());
  return claude;
}
