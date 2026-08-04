/** Machine-local harness policy setup and interactive wizard. */
import * as clack from "@clack/prompts";
import { Command, InvalidArgumentError } from "commander";
import { resolveCredentials } from "../credentials.ts";
import {
  detectInstalledHarnesses,
  type HarnessDescriptor,
  type HarnessName,
  installHarness,
  isHarnessInstalled,
  parseHarnessName,
} from "../harness/registry.ts";
import {
  canonicalizeDirectory,
  type HarnessProfile,
  readLocalConfig,
  writeDefaults,
  writeDirectoryProfile,
} from "../local-config.ts";
import { buildUserClient } from "../util.ts";
import { authenticateLogin } from "./login.ts";

type Space = { slug: string; name: string };
type Scope = { kind: "defaults" } | { kind: "directory"; directory: string };

interface InitOptions {
  defaults?: boolean;
  mcpServer?: string;
  mcpSpace?: string;
  mcpMultiSpace?: boolean;
  mcpHarness: string[];
  captureServer?: string;
  captureSpace?: string;
  captureTree?: string;
  captureTreeRoot?: string;
  captureHarness: string[];
  cliServer?: string;
  cliSpace?: string;
  cliHarness: string[];
}

function collectHarness(value: string, previous: string[]): string[] {
  parseHarnessName(value);
  return [...previous, value];
}

function harnesses(values: string[]): Record<string, true> {
  return Object.fromEntries(values.map((value) => [value, true]));
}

function disabledProfile(): HarnessProfile {
  return {
    mcp: { enabled: false, harnesses: {} },
    capture: { enabled: false, harnesses: {} },
    cli: { harnesses: {} },
  };
}

export function validateInitServer(value: string, option: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError(`${option} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidArgumentError(`${option} must use http(s)`);
  }
  if (url.username || url.password) {
    throw new InvalidArgumentError(`${option} must not include credentials`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new InvalidArgumentError(`${option} must be a server origin`);
  }
  return url.origin;
}

function normalizeTree(value: string): string {
  const tree = value.trim();
  if (!tree) throw new InvalidArgumentError("A tree path is required.");
  return tree;
}

function hasSurfaceFlags(opts: InitOptions): boolean {
  return Boolean(
    opts.mcpServer ||
      opts.mcpSpace ||
      opts.mcpMultiSpace ||
      opts.mcpHarness.length ||
      opts.captureServer ||
      opts.captureSpace ||
      opts.captureTree ||
      opts.captureTreeRoot ||
      opts.captureHarness.length ||
      opts.cliServer ||
      opts.cliSpace ||
      opts.cliHarness.length,
  );
}

function resolveExplicitScope(
  directory: string | undefined,
  opts: InitOptions,
): Scope | undefined {
  if (directory && opts.defaults) {
    throw new InvalidArgumentError(
      "directory and --defaults are mutually exclusive",
    );
  }
  if (directory) return { kind: "directory", directory };
  if (opts.defaults) return { kind: "defaults" };
  return undefined;
}

function validateScopeOptions(scope: Scope, opts: InitOptions): void {
  if (opts.mcpSpace && opts.mcpMultiSpace) {
    throw new InvalidArgumentError(
      "--mcp-space and --mcp-multi-space conflict",
    );
  }
  if (scope.kind === "directory" && opts.captureTreeRoot) {
    throw new InvalidArgumentError(
      "--capture-tree-root is only valid with --defaults",
    );
  }
  if (scope.kind === "defaults" && opts.captureTree) {
    throw new InvalidArgumentError(
      "--capture-tree is only valid for a directory profile",
    );
  }
}

/** Build the complete, deterministic profile described by surface flags. */
export function buildInitProfile(
  scope: Scope,
  opts: InitOptions,
): HarnessProfile {
  validateScopeOptions(scope, opts);
  const profile = disabledProfile();
  const mcpSelected = opts.mcpHarness.length > 0;
  if (mcpSelected || opts.mcpServer || opts.mcpSpace || opts.mcpMultiSpace) {
    if (!mcpSelected || !opts.mcpServer) {
      throw new InvalidArgumentError(
        "enabled MCP requires --mcp-server and --mcp-harness",
      );
    }
    profile.mcp = {
      enabled: true,
      server: validateInitServer(opts.mcpServer, "--mcp-server"),
      ...(opts.mcpSpace ? { space: opts.mcpSpace } : {}),
      harnesses: harnesses(opts.mcpHarness),
    };
  }

  const captureSelected = opts.captureHarness.length > 0;
  if (
    captureSelected ||
    opts.captureServer ||
    opts.captureSpace ||
    opts.captureTree ||
    opts.captureTreeRoot
  ) {
    if (!captureSelected || !opts.captureServer || !opts.captureSpace) {
      throw new InvalidArgumentError(
        "enabled capture requires --capture-server, --capture-space, and --capture-harness",
      );
    }
    if (scope.kind === "directory" && !opts.captureTree) {
      throw new InvalidArgumentError(
        "directory capture requires --capture-tree",
      );
    }
    if (scope.kind === "defaults" && !opts.captureTreeRoot) {
      throw new InvalidArgumentError(
        "default capture requires --capture-tree-root",
      );
    }
    profile.capture = {
      enabled: true,
      server: validateInitServer(opts.captureServer, "--capture-server"),
      space: opts.captureSpace,
      ...(opts.captureTree ? { tree: normalizeTree(opts.captureTree) } : {}),
      ...(opts.captureTreeRoot
        ? { tree_root: normalizeTree(opts.captureTreeRoot) }
        : {}),
      harnesses: harnesses(opts.captureHarness),
    };
  }

  const cliSelected = opts.cliHarness.length > 0;
  if (cliSelected || opts.cliServer || opts.cliSpace) {
    if (!cliSelected || !opts.cliServer) {
      throw new InvalidArgumentError(
        "enabled CLI routing requires --cli-server and --cli-harness",
      );
    }
    profile.cli = {
      server: validateInitServer(opts.cliServer, "--cli-server"),
      ...(opts.cliSpace ? { space: opts.cliSpace } : {}),
      harnesses: harnesses(opts.cliHarness),
    };
  }
  return profile;
}

function cancel<T>(value: T | symbol): T {
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    process.exit(0);
  }
  return value as T;
}

function existingProfile(scope: Scope): HarnessProfile | undefined {
  const config = readLocalConfig();
  return scope.kind === "defaults"
    ? config.defaults
    : config.directories[canonicalizeDirectory(scope.directory)];
}

function writeProfile(scope: Scope, profile: HarnessProfile): void {
  if (scope.kind === "defaults") writeDefaults(profile);
  else writeDirectoryProfile(scope.directory, profile);
}

async function selectScope(): Promise<Scope> {
  const choice = cancel(
    await clack.select({
      message: "Where should this configuration apply?",
      options: [
        {
          value: "directory",
          label: `This directory: ${canonicalizeDirectory(process.cwd())}`,
        },
        {
          value: "defaults",
          label: "Defaults for directories without their own configuration",
        },
      ],
    }),
  );
  return choice === "defaults"
    ? { kind: "defaults" }
    : { kind: "directory", directory: process.cwd() };
}

async function confirmReplacement(scope: Scope): Promise<boolean> {
  if (!existingProfile(scope)) return true;
  return cancel(
    await clack.confirm({
      message:
        scope.kind === "defaults"
          ? "Replace the existing defaults profile?"
          : `Replace the existing profile for ${canonicalizeDirectory(scope.directory)}?`,
      initialValue: false,
    }),
  );
}

function browserLikelyAvailable(): boolean {
  if (process.platform === "darwin" || process.platform === "win32")
    return true;
  return Boolean(
    (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) &&
      Bun.which("xdg-open"),
  );
}

async function authenticateForWizard(): Promise<{
  server: string;
  spaces: Space[];
}> {
  let creds = resolveCredentials();
  let user: ReturnType<typeof buildUserClient>;
  const login = async (): Promise<ReturnType<typeof buildUserClient>> => {
    const shouldLogin = cancel(
      await clack.confirm({
        message:
          "Memory Engine needs to know which spaces you can use. Log in now?",
        initialValue: true,
      }),
    );
    if (!shouldLogin) {
      clack.log.info("Run 'me login', then re-run 'me init'.");
      process.exit(0);
      throw new Error("unreachable");
    }
    const browser = browserLikelyAvailable();
    const flow = cancel(
      await clack.select({
        message: "How would you like to sign in?",
        options: browser
          ? [
              { value: "browser", label: "Use this computer's browser" },
              { value: "device", label: "Use a device code instead" },
            ]
          : [
              { value: "device", label: "Use a device code" },
              {
                value: "browser",
                label: "Use this computer's browser instead",
              },
            ],
      }),
    );
    const authenticated = await authenticateLogin({
      server: creds.server,
      device: flow === "device",
      browser: true,
    });
    creds = { ...creds, server: authenticated.server };
    return authenticated.user;
  };

  if (creds.apiKey || creds.loggedIn) {
    user = buildUserClient(creds);
  } else {
    user = await login();
  }

  let spaces: Space[];
  try {
    ({ spaces } = await user.space.list());
  } catch {
    clack.log.warn(
      "Current credentials could not list spaces. Sign in again to continue.",
    );
    const retry = cancel(
      await clack.confirm({ message: "Sign in again?", initialValue: true }),
    );
    if (!retry) {
      clack.log.info("Run 'me login', then re-run 'me init'.");
      process.exit(0);
      throw new Error("unreachable");
    }
    user = await login();
    ({ spaces } = await user.space.list());
  }
  if (spaces.length === 0) {
    const create = cancel(
      await clack.confirm({
        message: "You have no spaces yet. Create a personal space now?",
        initialValue: true,
      }),
    );
    if (!create) {
      clack.log.info(
        "Memory Engine needs a space before it can configure MCP tools or capture. Run 'me space create <name>' or accept an invitation, then run 'me init' again.",
      );
      process.exit(0);
    }
    await user.space.ensureDefault();
    ({ spaces } = await user.space.list());
  }
  return { server: creds.server, spaces };
}

async function installMissingHarnesses(): Promise<HarnessDescriptor[]> {
  const detected = detectInstalledHarnesses();
  const missing = detected.filter(
    (harness) => !isHarnessInstalled(harness.name),
  );
  if (missing.length === 0)
    return detected.filter((harness) => isHarnessInstalled(harness.name));
  if (missing.length === 1) {
    const harness = missing[0];
    if (!harness) return [];
    const install = cancel(
      await clack.confirm({
        message: `MCP tools for ${harness.displayName} are not installed. Install now?`,
        initialValue: true,
      }),
    );
    if (install) await installHarness(harness.name);
  } else {
    const selected = cancel(
      await clack.multiselect({
        message: "Install MCP tools for:",
        required: false,
        options: missing.map((harness) => ({
          value: harness.name,
          label: harness.displayName,
        })),
      }),
    ) as HarnessName[];
    for (const name of selected) await installHarness(name);
  }
  return detected.filter((harness) => isHarnessInstalled(harness.name));
}

async function selectHarnesses(
  message: string,
  available: HarnessDescriptor[],
): Promise<HarnessName[]> {
  if (available.length === 0) {
    clack.log.info(
      "No installed supported coding-agent harnesses were detected.",
    );
    return [];
  }
  for (;;) {
    const selected = cancel(
      await clack.multiselect({
        message,
        required: false,
        options: available.map((harness) => ({
          value: harness.name,
          label: harness.displayName,
        })),
      }),
    ) as HarnessName[];
    if (selected.length > 0) return selected;
    clack.log.warn("Select at least one harness to enable this surface.");
  }
}

async function selectSpace(
  message: string,
  spaces: Space[],
  allowMultiSpace = false,
): Promise<string | undefined> {
  const options = [
    ...spaces.map((space) => ({
      value: space.slug,
      label: `${space.name} (${space.slug})`,
    })),
    ...(allowMultiSpace
      ? [
          {
            value: "__multi__",
            label: "Let the agent choose a space for each request",
          },
        ]
      : []),
  ];
  const selected = cancel(await clack.select({ message, options }));
  return selected === "__multi__" ? undefined : (selected as string);
}

async function promptServer(
  message: string,
  initialValue: string,
): Promise<string> {
  for (;;) {
    const value = cancel(
      await clack.text({
        message,
        initialValue,
        validate: (raw) => {
          try {
            validateInitServer(raw ?? "", message);
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
      }),
    );
    return validateInitServer(value ?? "", message);
  }
}

async function promptTree(message: string): Promise<string> {
  return normalizeTree(
    cancel(
      await clack.text({
        message,
        validate: (value) =>
          value?.trim() ? undefined : "A tree path is required.",
      }),
    ),
  );
}

async function buildWizardProfile(
  scope: Scope,
  server: string,
  spaces: Space[],
  available: HarnessDescriptor[],
): Promise<HarnessProfile> {
  const profile = disabledProfile();
  if (available.length === 0) {
    clack.log.info(
      "No installed supported coding-agent harnesses were detected. Skipping MCP, capture, and CLI setup.",
    );
    return profile;
  }

  const mcp = cancel(
    await clack.confirm({
      message: "Make MCP tools available to coding agents here?",
    }),
  );
  if (mcp) {
    const selected = await selectHarnesses(
      "Which harnesses should have MCP tools here?",
      available,
    );
    const space = await selectSpace(
      "Which space should the MCP tools use?",
      spaces,
      true,
    );
    profile.mcp = {
      enabled: true,
      server: await promptServer("MCP server URL", server),
      ...(space ? { space } : {}),
      harnesses: harnesses(selected),
    };
  }

  const capture = cancel(
    await clack.confirm({ message: "Capture coding-agent sessions here?" }),
  );
  if (capture) {
    const selected = await selectHarnesses(
      "Which harnesses should capture sessions here?",
      available,
    );
    if (scope.kind === "defaults") {
      clack.log.warn(
        "Sessions from otherwise-unconfigured directories will be captured to this destination.",
      );
    }
    profile.capture = {
      enabled: true,
      server: await promptServer("Capture server URL", server),
      space: (await selectSpace(
        "Which space should captured sessions go to?",
        spaces,
      )) as string,
      ...(scope.kind === "directory"
        ? { tree: await promptTree("Project memory location") }
        : { tree_root: await promptTree("Capture tree root") }),
      harnesses: harnesses(selected),
    };
  }

  const cli = cancel(
    await clack.confirm({
      message:
        "Route Memory Engine CLI commands run by these harnesses to this space? Your own me commands are not affected.",
    }),
  );
  if (cli) {
    const selected = await selectHarnesses(
      "Which harnesses should use CLI routing here?",
      available,
    );
    const space = await selectSpace(
      "Which space should harness CLI commands use?",
      spaces,
    );
    profile.cli = {
      server: await promptServer("CLI server URL", server),
      ...(space ? { space } : {}),
      harnesses: harnesses(selected),
    };
  }
  return profile;
}

async function runWizard(scope: Scope): Promise<void> {
  if (!(await confirmReplacement(scope))) {
    clack.cancel("Cancelled.");
    return;
  }
  const { server, spaces } = await authenticateForWizard();
  const installed = await installMissingHarnesses();
  const profile = await buildWizardProfile(scope, server, spaces, installed);
  clack.note(JSON.stringify(profile, null, 2), "Profile to write");
  const confirmed = cancel(
    await clack.confirm({ message: "Write this profile?", initialValue: true }),
  );
  if (!confirmed) {
    clack.cancel("Cancelled.");
    return;
  }
  writeProfile(scope, profile);
  clack.outro("Machine-local harness policy configured.");
}

export function createInitCommand(): Command {
  return new Command("init")
    .description("configure machine-local harness policy")
    .argument("[directory]", "directory profile to write")
    .option("--defaults", "write the fallback defaults profile")
    .option("--mcp-server <url>", "MCP server URL")
    .option("--mcp-space <slug>", "lock MCP to this space")
    .option("--mcp-multi-space", "leave MCP unpinned so tools require a space")
    .option(
      "--mcp-harness <name>",
      "enable MCP for a harness",
      collectHarness,
      [],
    )
    .option("--capture-server <url>", "capture server URL")
    .option("--capture-space <slug>", "capture destination space")
    .option("--capture-tree <path>", "capture tree for a directory profile")
    .option("--capture-tree-root <path>", "capture tree root for defaults")
    .option(
      "--capture-harness <name>",
      "enable capture for a harness",
      collectHarness,
      [],
    )
    .option("--cli-server <url>", "CLI server URL for harness shells")
    .option("--cli-space <slug>", "CLI space for harness shells")
    .option(
      "--cli-harness <name>",
      "enable CLI targeting for a harness",
      collectHarness,
      [],
    )
    .action(async (directory: string | undefined, opts: InitOptions) => {
      let scope = resolveExplicitScope(directory, opts);
      if (!scope) {
        if (!process.stdin.isTTY) {
          throw new InvalidArgumentError(
            "me init requires a directory or --defaults when stdin is not a TTY",
          );
        }
        scope = await selectScope();
      }
      if (hasSurfaceFlags(opts) || !process.stdin.isTTY) {
        writeProfile(scope, buildInitProfile(scope, opts));
        return;
      }
      await runWizard(scope);
    });
}
