/** Machine-local harness policy setup and interactive wizard. */
import * as clack from "@clack/prompts";
import { Command, InvalidArgumentError } from "commander";
import { getGlobalConfigPath, resolveCredentials } from "../credentials.ts";
import {
  detectInstalledHarnesses,
  type HarnessDescriptor,
  type HarnessName,
  installHarness,
  isHarnessInstalled,
  parseHarnessName,
} from "../harness/registry.ts";
import { ProjectRegistry } from "../importers/project.ts";
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
  verbose?: boolean;
  server?: string;
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

type InitPrompts = Pick<
  typeof clack,
  | "cancel"
  | "confirm"
  | "isCancel"
  | "multiselect"
  | "note"
  | "outro"
  | "select"
  | "text"
> & {
  log: Pick<typeof clack.log, "info" | "warn">;
};

export interface InitDependencies {
  prompts: InitPrompts;
  resolveCredentials: typeof resolveCredentials;
  buildUserClient: typeof buildUserClient;
  authenticateLogin: typeof authenticateLogin;
  detectInstalledHarnesses: typeof detectInstalledHarnesses;
  isHarnessInstalled: typeof isHarnessInstalled;
  installHarness: typeof installHarness;
  readLocalConfig: typeof readLocalConfig;
  writeDefaults: typeof writeDefaults;
  writeDirectoryProfile: typeof writeDirectoryProfile;
  canonicalizeDirectory: typeof canonicalizeDirectory;
  getGlobalConfigPath: typeof getGlobalConfigPath;
  resolveProjectSlug: (directory: string) => Promise<string>;
  cwd: () => string;
  isTTY: () => boolean;
  exit: (code?: number) => never;
  browserLikelyAvailable: () => boolean;
}

const defaultDependencies: InitDependencies = {
  prompts: clack,
  resolveCredentials,
  buildUserClient,
  authenticateLogin,
  detectInstalledHarnesses,
  isHarnessInstalled,
  installHarness,
  readLocalConfig,
  writeDefaults,
  writeDirectoryProfile,
  canonicalizeDirectory,
  getGlobalConfigPath,
  resolveProjectSlug: async (directory) =>
    (await new ProjectRegistry().resolve(directory)).slug,
  cwd: () => process.cwd(),
  isTTY: () => Boolean(process.stdin.isTTY),
  exit: (code) => process.exit(code),
  browserLikelyAvailable,
};

function resolveDependencies(
  overrides: Partial<InitDependencies> = {},
): InitDependencies {
  return { ...defaultDependencies, ...overrides };
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

function cancel<T>(deps: InitDependencies, value: T | symbol): T {
  if (deps.prompts.isCancel(value)) {
    deps.prompts.cancel("Cancelled.");
    deps.exit(0);
  }
  return value as T;
}

function existingProfile(
  deps: InitDependencies,
  scope: Scope,
): HarnessProfile | undefined {
  const config = deps.readLocalConfig();
  return scope.kind === "defaults"
    ? config.defaults
    : config.directories[deps.canonicalizeDirectory(scope.directory)];
}

function writeProfile(
  deps: InitDependencies,
  scope: Scope,
  profile: HarnessProfile,
): void {
  if (scope.kind === "defaults") deps.writeDefaults(profile);
  else deps.writeDirectoryProfile(scope.directory, profile);
}

async function selectScope(deps: InitDependencies): Promise<Scope> {
  const choice = cancel(
    deps,
    await deps.prompts.select({
      message: "Where should this configuration apply?",
      options: [
        {
          value: "directory",
          label: `This directory: ${deps.canonicalizeDirectory(deps.cwd())}`,
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
    : { kind: "directory", directory: deps.cwd() };
}

async function confirmReplacement(
  deps: InitDependencies,
  scope: Scope,
): Promise<boolean> {
  if (!existingProfile(deps, scope)) return true;
  return cancel(
    deps,
    await deps.prompts.confirm({
      message:
        scope.kind === "defaults"
          ? "Replace the existing defaults profile?"
          : `Replace the existing profile for ${deps.canonicalizeDirectory(scope.directory)}?`,
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

async function authenticateForWizard(
  deps: InitDependencies,
  serverFlag?: string,
): Promise<{
  server: string;
  spaces: Space[];
  activeSpace?: string;
}> {
  let creds = deps.resolveCredentials(serverFlag);
  let user: ReturnType<typeof buildUserClient>;
  const login = async (): Promise<ReturnType<typeof buildUserClient>> => {
    const shouldLogin = cancel(
      deps,
      await deps.prompts.confirm({
        message:
          "Memory Engine needs to know which spaces you can use. Log in now?",
        initialValue: true,
      }),
    );
    if (!shouldLogin) {
      deps.prompts.log.info("Run 'me login', then re-run 'me init'.");
      deps.exit(0);
      throw new Error("unreachable");
    }
    const browser = deps.browserLikelyAvailable();
    const flow = cancel(
      deps,
      await deps.prompts.select({
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
    const authenticated = await deps.authenticateLogin({
      server: creds.server,
      device: flow === "device",
      browser: true,
    });
    creds = { ...creds, server: authenticated.server };
    return authenticated.user;
  };

  if (creds.apiKey || creds.loggedIn) {
    user = deps.buildUserClient(creds);
  } else {
    user = await login();
  }

  let spaces: Space[];
  try {
    ({ spaces } = await user.space.list());
  } catch {
    deps.prompts.log.warn(
      "Current credentials could not list spaces. Sign in again to continue.",
    );
    const retry = cancel(
      deps,
      await deps.prompts.confirm({
        message: "Sign in again?",
        initialValue: true,
      }),
    );
    if (!retry) {
      deps.prompts.log.info("Run 'me login', then re-run 'me init'.");
      deps.exit(0);
      throw new Error("unreachable");
    }
    user = await login();
    ({ spaces } = await user.space.list());
  }
  if (spaces.length === 0) {
    const create = cancel(
      deps,
      await deps.prompts.confirm({
        message: "You have no spaces yet. Create a personal space now?",
        initialValue: true,
      }),
    );
    if (!create) {
      deps.prompts.log.info(
        "Memory Engine needs a space before it can configure MCP tools or capture. Run 'me space create <name>' or accept an invitation, then run 'me init' again.",
      );
      deps.exit(0);
    }
    await user.space.ensureDefault();
    ({ spaces } = await user.space.list());
  }
  return { server: creds.server, spaces, activeSpace: creds.activeSpace };
}

async function installMissingHarnesses(
  deps: InitDependencies,
): Promise<HarnessDescriptor[]> {
  const detected = deps.detectInstalledHarnesses();
  const missing = detected.filter(
    (harness) => !deps.isHarnessInstalled(harness.name),
  );
  if (missing.length === 0)
    return detected.filter((harness) => deps.isHarnessInstalled(harness.name));
  if (missing.length === 1) {
    const harness = missing[0];
    if (!harness) return [];
    const install = cancel(
      deps,
      await deps.prompts.confirm({
        message: `MCP tools for ${harness.displayName} are not installed. Install now?`,
        initialValue: true,
      }),
    );
    if (install) await deps.installHarness(harness.name);
  } else {
    const selected = cancel(
      deps,
      await deps.prompts.multiselect({
        message: "Install MCP tools for:",
        required: false,
        options: missing.map((harness) => ({
          value: harness.name,
          label: harness.displayName,
        })),
      }),
    ) as HarnessName[];
    for (const name of selected) await deps.installHarness(name);
  }
  return detected.filter((harness) => deps.isHarnessInstalled(harness.name));
}

async function selectHarnesses(
  deps: InitDependencies,
  message: string,
  available: HarnessDescriptor[],
): Promise<HarnessName[]> {
  if (available.length === 0) {
    deps.prompts.log.info(
      "No installed supported coding-agent harnesses were detected.",
    );
    return [];
  }
  for (;;) {
    const selected = cancel(
      deps,
      await deps.prompts.multiselect({
        message,
        required: false,
        options: available.map((harness) => ({
          value: harness.name,
          label: harness.displayName,
        })),
      }),
    ) as HarnessName[];
    if (selected.length > 0) return selected;
    deps.prompts.log.warn(
      "Select at least one harness to enable this surface.",
    );
  }
}

async function selectSpace(
  deps: InitDependencies,
  message: string,
  spaces: Space[],
  allowMultiSpace = false,
  initialValue?: string,
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
  const selected = cancel(
    deps,
    await deps.prompts.select({
      message,
      options,
      ...(initialValue ? { initialValue } : {}),
    }),
  );
  return selected === "__multi__" ? undefined : (selected as string);
}

async function promptServer(
  deps: InitDependencies,
  message: string,
  initialValue: string,
): Promise<string> {
  for (;;) {
    const value = cancel(
      deps,
      await deps.prompts.text({
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

async function promptTree(
  deps: InitDependencies,
  message: string,
  initialValue?: string,
): Promise<string> {
  return normalizeTree(
    cancel(
      deps,
      await deps.prompts.text({
        message,
        ...(initialValue ? { initialValue } : {}),
        validate: (value) =>
          value?.trim() ? undefined : "A tree path is required.",
      }),
    ),
  );
}

async function buildWizardProfile(
  deps: InitDependencies,
  scope: Scope,
  server: string,
  spaces: Space[],
  available: HarnessDescriptor[],
): Promise<HarnessProfile> {
  const profile = disabledProfile();
  if (available.length === 0) {
    deps.prompts.log.info(
      "No installed supported coding-agent harnesses were detected. Skipping MCP, capture, and CLI setup.",
    );
    return profile;
  }

  const mcp = cancel(
    deps,
    await deps.prompts.confirm({
      message: "Make MCP tools available to coding agents here?",
    }),
  );
  if (mcp) {
    const selected = await selectHarnesses(
      deps,
      "Which harnesses should have MCP tools here?",
      available,
    );
    const space = await selectSpace(
      deps,
      "Which space should the MCP tools use?",
      spaces,
      true,
    );
    profile.mcp = {
      enabled: true,
      server: await promptServer(deps, "MCP server URL", server),
      ...(space ? { space } : {}),
      harnesses: harnesses(selected),
    };
  }

  const capture = cancel(
    deps,
    await deps.prompts.confirm({
      message: "Capture coding-agent sessions here?",
    }),
  );
  if (capture) {
    const selected = await selectHarnesses(
      deps,
      "Which harnesses should capture sessions here?",
      available,
    );
    if (scope.kind === "defaults") {
      deps.prompts.log.warn(
        "Sessions from otherwise-unconfigured directories will be captured to this destination.",
      );
    }
    profile.capture = {
      enabled: true,
      server: await promptServer(deps, "Capture server URL", server),
      space: (await selectSpace(
        deps,
        "Which space should captured sessions go to?",
        spaces,
      )) as string,
      ...(scope.kind === "directory"
        ? { tree: await promptTree(deps, "Project memory location") }
        : { tree_root: await promptTree(deps, "Capture tree root") }),
      harnesses: harnesses(selected),
    };
  }

  const cli = cancel(
    deps,
    await deps.prompts.confirm({
      message:
        "Route Memory Engine CLI commands run by these harnesses to this space? Your own me commands are not affected.",
    }),
  );
  if (cli) {
    const selected = await selectHarnesses(
      deps,
      "Which harnesses should use CLI routing here?",
      available,
    );
    const space = await selectSpace(
      deps,
      "Which space should harness CLI commands use?",
      spaces,
    );
    profile.cli = {
      server: await promptServer(deps, "CLI server URL", server),
      ...(space ? { space } : {}),
      harnesses: harnesses(selected),
    };
  }
  return profile;
}

async function runWizard(deps: InitDependencies, scope: Scope): Promise<void> {
  if (!(await confirmReplacement(deps, scope))) {
    deps.prompts.cancel("Cancelled.");
    return;
  }
  const { server, spaces } = await authenticateForWizard(deps);
  const installed = await installMissingHarnesses(deps);
  const profile = await buildWizardProfile(
    deps,
    scope,
    server,
    spaces,
    installed,
  );
  deps.prompts.note(JSON.stringify(profile, null, 2), "Profile to write");
  const confirmed = cancel(
    deps,
    await deps.prompts.confirm({
      message: "Write this profile?",
      initialValue: true,
    }),
  );
  if (!confirmed) {
    deps.prompts.cancel("Cancelled.");
    return;
  }
  writeProfile(deps, scope, profile);
  deps.prompts.outro("Machine-local harness policy configured.");
}

async function selectQuickSpace(
  deps: InitDependencies,
  spaces: Space[],
  activeSpace: string | undefined,
): Promise<string> {
  const [onlySpace] = spaces;
  if (spaces.length === 1 && onlySpace) return onlySpace.slug;
  return (await selectSpace(
    deps,
    "Which space should Memory Engine use here?",
    spaces,
    false,
    spaces.some((space) => space.slug === activeSpace)
      ? activeSpace
      : undefined,
  )) as string;
}

async function runQuickInit(
  deps: InitDependencies,
  directory: string,
  server: string,
): Promise<void> {
  const scope: Scope = { kind: "directory", directory };
  if (!(await confirmReplacement(deps, scope))) {
    deps.prompts.cancel("Cancelled.");
    return;
  }
  const {
    server: resolvedServer,
    spaces,
    activeSpace,
  } = await authenticateForWizard(deps, server);
  const selectedSpace = await selectQuickSpace(deps, spaces, activeSpace);
  const detected = deps.detectInstalledHarnesses();
  const selectedHarnesses = detected.map((harness) => harness.name);
  const profile = disabledProfile();
  if (selectedHarnesses.length > 0) {
    profile.mcp = {
      enabled: true,
      server: resolvedServer,
      space: selectedSpace,
      harnesses: harnesses(selectedHarnesses),
    };
    profile.cli = {
      server: resolvedServer,
      space: selectedSpace,
      harnesses: harnesses(selectedHarnesses),
    };
    const capture = cancel(
      deps,
      await deps.prompts.confirm({
        message: "Make session capture available here?",
        initialValue: false,
      }),
    );
    if (capture) {
      const slug = await deps.resolveProjectSlug(directory);
      deps.prompts.log.info(
        `Use ~/projects/${slug} instead to capture sessions privately.`,
      );
      profile.capture = {
        enabled: true,
        server: resolvedServer,
        space: selectedSpace,
        tree: await promptTree(
          deps,
          "Project memory location",
          `/share/projects/${slug}`,
        ),
        harnesses: harnesses(selectedHarnesses),
      };
    }
  } else {
    deps.prompts.log.info(
      "No supported coding-agent harnesses were detected. MCP, capture, and CLI routing remain disabled.",
    );
  }

  const missing = detected.filter(
    (harness) => !deps.isHarnessInstalled(harness.name),
  );
  if (missing.length > 0) {
    const install = cancel(
      deps,
      await deps.prompts.confirm({
        message: `Install integrations for ${missing.map((harness) => harness.displayName).join(", ")} now?`,
        initialValue: true,
      }),
    );
    if (install) {
      for (const harness of missing) await deps.installHarness(harness.name);
    } else {
      deps.prompts.log.info(
        `Run 'me install ${missing.map((harness) => harness.name).join(" ")}' when you are ready.`,
      );
    }
  }

  deps.prompts.note(JSON.stringify(profile, null, 2), "Profile to write");
  const confirmed = cancel(
    deps,
    await deps.prompts.confirm({
      message: "Write this profile?",
      initialValue: true,
    }),
  );
  if (!confirmed) {
    deps.prompts.cancel("Cancelled.");
    return;
  }
  writeProfile(deps, scope, profile);
  deps.prompts.outro(
    `Configured ${deps.canonicalizeDirectory(directory)} in ${deps.getGlobalConfigPath()}. Run 'me init --verbose' for advanced setup.`,
  );
}

export async function runInit(
  directory: string | undefined,
  opts: InitOptions,
  dependencies: Partial<InitDependencies> = {},
): Promise<void> {
  const deps = resolveDependencies(dependencies);
  if (opts.verbose && hasSurfaceFlags(opts)) {
    throw new InvalidArgumentError(
      "--verbose cannot be combined with surface options",
    );
  }
  let scope = resolveExplicitScope(directory, opts);
  if (!scope) {
    if (!deps.isTTY()) {
      throw new InvalidArgumentError(
        "me init requires a directory or --defaults when stdin is not a TTY",
      );
    }
    scope =
      opts.verbose || hasSurfaceFlags(opts)
        ? await selectScope(deps)
        : { kind: "directory", directory: deps.cwd() };
  }
  if (hasSurfaceFlags(opts)) {
    writeProfile(deps, scope, buildInitProfile(scope, opts));
    return;
  }
  if (!deps.isTTY()) {
    throw new InvalidArgumentError(
      "me init requires surface options when stdin is not a TTY",
    );
  }
  if (opts.defaults || opts.verbose) {
    await runWizard(deps, scope);
    return;
  }
  if (scope.kind === "defaults") {
    await runWizard(deps, scope);
    return;
  }
  await runQuickInit(
    deps,
    deps.canonicalizeDirectory(scope.directory),
    opts.server ?? process.env.ME_SERVER ?? "https://api.memory.build",
  );
}

export function createInitCommand(
  dependencies: Partial<InitDependencies> = {},
): Command {
  return new Command("init")
    .description("configure machine-local harness policy")
    .argument("[directory]", "directory profile to write")
    .option("--defaults", "write the fallback defaults profile")
    .option("-v, --verbose", "configure each harness surface independently")
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
    .action((directory: string | undefined, opts: InitOptions, cmd: Command) =>
      runInit(
        directory,
        { ...opts, server: cmd.optsWithGlobals().server as string | undefined },
        dependencies,
      ),
    );
}
