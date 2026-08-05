import { expect, test } from "bun:test";
import {
  buildInitProfile,
  type InitDependencies,
  runInit,
  validateInitServer,
} from "./init.ts";

const baseOptions = {
  mcpHarness: [],
  captureHarness: [],
  cliHarness: [],
};

const space = { slug: "abc123def456", name: "Personal" };

function fakeUser(
  spaces: (typeof space)[],
  ensureDefault?: () => Promise<void>,
) {
  return {
    space: {
      list: async () => ({ spaces }),
      ensureDefault: ensureDefault ?? (async () => {}),
    },
  };
}

function wizardDependencies({
  confirms = [],
  selects = [],
  multiselects = [],
  texts = [],
  user = fakeUser([space]),
  detected = [],
  installed = [],
  defaults,
  activeSpace,
}: {
  confirms?: boolean[];
  selects?: string[];
  multiselects?: string[][];
  texts?: string[];
  user?: ReturnType<typeof fakeUser>;
  detected?: { name: string; displayName: string }[];
  installed?: string[];
  defaults?: unknown;
  activeSpace?: string;
} = {}) {
  const writes: unknown[] = [];
  const logs: string[] = [];
  const outros: string[] = [];
  const selectCalls: unknown[] = [];
  const textCalls: unknown[] = [];
  const prompts = {
    cancel: (message: string) => logs.push(`cancel:${message}`),
    confirm: async () => confirms.shift() ?? false,
    isCancel: () => false,
    multiselect: async () => multiselects.shift() ?? [],
    note: () => {},
    outro: (message: string) => outros.push(message),
    select: async (options: unknown) => {
      selectCalls.push(options);
      return selects.shift() ?? "";
    },
    text: async (options: unknown) => {
      textCalls.push(options);
      return texts.shift() ?? "";
    },
    log: {
      info: (message: string) => logs.push(`info:${message}`),
      warn: (message: string) => logs.push(`warn:${message}`),
    },
  };
  const dependencies: Partial<InitDependencies> = {
    prompts: prompts as unknown as InitDependencies["prompts"],
    resolveCredentials: () => ({
      server: "https://api.memory.build",
      loggedIn: true,
      activeSpace,
    }),
    buildUserClient: () => user as never,
    detectInstalledHarnesses: () => detected as never,
    isHarnessInstalled: (name) => installed.includes(name),
    installHarness: async () => {},
    readLocalConfig: () =>
      ({ defaults, directories: {} }) as ReturnType<
        InitDependencies["readLocalConfig"]
      >,
    writeDefaults: (profile) => writes.push({ scope: "defaults", profile }),
    writeDirectoryProfile: (directory, profile) =>
      writes.push({ scope: directory, profile }),
    canonicalizeDirectory: (directory) =>
      directory === "." ? "/repo" : directory,
    getGlobalConfigPath: () => "/home/test/.config/me/config.yaml",
    resolveProjectSlug: async () => "demo",
    cwd: () => "/repo",
    isTTY: () => true,
    exit: () => {
      throw new Error("exit");
    },
    browserLikelyAvailable: () => false,
  };
  return { dependencies, writes, logs, outros, selectCalls, textCalls };
}

test("me init server flags require absolute http(s) URLs", () => {
  expect(validateInitServer("https://api.memory.build", "--mcp-server")).toBe(
    "https://api.memory.build",
  );
  expect(() => validateInitServer("api.memory.build", "--mcp-server")).toThrow(
    "absolute http(s) URL",
  );
  expect(() => validateInitServer("ftp://example.com", "--cli-server")).toThrow(
    "must use http(s)",
  );
  expect(() =>
    validateInitServer("https://user:password@example.com", "--mcp-server"),
  ).toThrow("must not include credentials");
  expect(() =>
    validateInitServer("https://api.memory.build/v1", "--mcp-server"),
  ).toThrow("must be a server origin");
  expect(validateInitServer("https://api.memory.build/", "--mcp-server")).toBe(
    "https://api.memory.build",
  );
});

test("me init trims capture trees before writing profiles", () => {
  expect(
    buildInitProfile(
      { kind: "directory", directory: "/repo" },
      {
        mcpHarness: [],
        captureHarness: ["claude"],
        captureServer: "https://api.memory.build",
        captureSpace: "abc123def456",
        captureTree: " /share/projects/demo ",
        cliHarness: [],
      },
    ).capture,
  ).toMatchObject({ tree: "/share/projects/demo" });
});

test("me init flag profiles explicitly disable omitted surfaces", () => {
  expect(
    buildInitProfile(
      { kind: "directory", directory: "/repo" },
      {
        mcpHarness: ["claude"],
        mcpServer: "https://api.memory.build",
        captureHarness: [],
        cliHarness: [],
      },
    ),
  ).toEqual({
    mcp: {
      enabled: true,
      server: "https://api.memory.build",
      harnesses: { claude: true },
    },
    capture: { enabled: false, harnesses: {} },
    cli: { harnesses: {} },
  });
});

test("me init validates capture scope in flag profiles", () => {
  expect(() =>
    buildInitProfile(
      { kind: "defaults" },
      {
        mcpHarness: [],
        captureHarness: ["codex"],
        captureServer: "https://api.memory.build",
        captureSpace: "abc123def456",
        captureTree: "/share/projects/demo",
        cliHarness: [],
      },
    ),
  ).toThrow("--capture-tree is only valid for a directory profile");
});

test("me init prompts for scope when surface flags omit it", async () => {
  const { dependencies, writes } = wizardDependencies({
    selects: ["defaults"],
  });

  await runInit(
    undefined,
    {
      ...baseOptions,
      mcpServer: "https://api.memory.build",
      mcpHarness: ["claude"],
    },
    dependencies,
  );

  expect(writes).toEqual([
    {
      scope: "defaults",
      profile: {
        mcp: {
          enabled: true,
          server: "https://api.memory.build",
          harnesses: { claude: true },
        },
        capture: { enabled: false, harnesses: {} },
        cli: { harnesses: {} },
      },
    },
  ]);
});

test("me init requires surface flags outside a TTY", async () => {
  const { dependencies, writes } = wizardDependencies();
  dependencies.isTTY = () => false;

  await expect(runInit("/repo", baseOptions, dependencies)).rejects.toThrow(
    "requires surface options",
  );
  expect(writes).toEqual([]);
});

test("me init skips surfaces when no harnesses are available", async () => {
  const { dependencies, writes, logs } = wizardDependencies({
    confirms: [true],
  });

  await runInit("/repo", baseOptions, dependencies);

  expect(logs).toContain(
    "info:No supported coding-agent harnesses were detected. MCP, capture, and CLI routing remain disabled.",
  );
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    scope: "/repo",
    profile: { mcp: { enabled: false }, capture: { enabled: false } },
  });
});

test("me init configures MCP, capture, and CLI independently", async () => {
  const { dependencies, writes } = wizardDependencies({
    confirms: [true, true, true, true],
    multiselects: [["claude"], ["claude"], ["claude"]],
    selects: ["__multi__", space.slug, space.slug],
    texts: [
      "https://api.memory.build",
      "https://api.memory.build",
      "/share/projects/demo",
      "https://api.memory.build",
    ],
    detected: [{ name: "claude", displayName: "Claude Code" }],
    installed: ["claude"],
  });

  await runInit("/repo", { ...baseOptions, verbose: true }, dependencies);

  expect(writes[0]).toEqual({
    scope: "/repo",
    profile: {
      mcp: {
        enabled: true,
        server: "https://api.memory.build",
        harnesses: { claude: true },
      },
      capture: {
        enabled: true,
        server: "https://api.memory.build",
        space: space.slug,
        tree: "/share/projects/demo",
        harnesses: { claude: true },
      },
      cli: {
        server: "https://api.memory.build",
        space: space.slug,
        harnesses: { claude: true },
      },
    },
  });
});

test("me init suppresses writes when the final confirmation is declined", async () => {
  const { dependencies, writes, logs } = wizardDependencies({
    confirms: [false],
  });

  await runInit("/repo", baseOptions, dependencies);

  expect(writes).toEqual([]);
  expect(logs).toContain("cancel:Cancelled.");
});

test("me init recovers from stale credentials by offering login", async () => {
  const staleUser = {
    space: {
      list: async () => {
        throw new Error("expired token");
      },
      ensureDefault: async () => {},
    },
  };
  const { dependencies, logs, writes } = wizardDependencies({
    confirms: [true, true, true],
    selects: ["device"],
    user: staleUser,
  });
  dependencies.authenticateLogin = async () =>
    ({
      server: "https://api.memory.build",
      tokens: {},
      user: fakeUser([space]),
    }) as never;

  await runInit("/repo", baseOptions, dependencies);

  expect(logs).toContain(
    "warn:Current credentials could not list spaces. Sign in again to continue.",
  );
  expect(writes).toHaveLength(1);
});

test("me init bootstraps a personal space only after the zero-space prompt", async () => {
  let lists = 0;
  let bootstrapped = false;
  const zeroSpaceUser = {
    space: {
      list: async () => ({ spaces: lists++ === 0 ? [] : [space] }),
      ensureDefault: async () => {
        bootstrapped = true;
      },
    },
  };
  const { dependencies, writes } = wizardDependencies({
    confirms: [true, true],
    user: zeroSpaceUser,
  });

  await runInit("/repo", baseOptions, dependencies);

  expect(bootstrapped).toBe(true);
  expect(writes).toHaveLength(1);
});

test("me init installs a detected harness before configuring surfaces", async () => {
  const installed = new Set<string>();
  const { dependencies, writes } = wizardDependencies({
    confirms: [false, true, true],
    detected: [{ name: "claude", displayName: "Claude Code" }],
  });
  dependencies.isHarnessInstalled = (name) => installed.has(name);
  dependencies.installHarness = async (name) => {
    installed.add(name);
  };

  await runInit("/repo", baseOptions, dependencies);

  expect(installed).toEqual(new Set(["claude"]));
  expect(writes).toHaveLength(1);
});

test("me init does not authenticate when replacing a profile is declined", async () => {
  const { dependencies, writes, logs } = wizardDependencies({
    confirms: [false],
    defaults: { mcp: { enabled: false, harnesses: {} } },
  });
  dependencies.buildUserClient = () => {
    throw new Error("must not authenticate");
  };

  await runInit(undefined, { ...baseOptions, defaults: true }, dependencies);

  expect(writes).toEqual([]);
  expect(logs).toContain("cancel:Cancelled.");
});

test("me init requires an explicit scope outside a TTY", async () => {
  const { dependencies } = wizardDependencies();
  dependencies.isTTY = () => false;

  await expect(
    runInit(undefined, { ...baseOptions, verbose: true }, dependencies),
  ).rejects.toThrow("requires a directory or --defaults");
});

test("me init exits without writing when a prompt is cancelled", async () => {
  const cancelled = Symbol("cancelled");
  const { dependencies, writes, logs } = wizardDependencies();
  dependencies.prompts = {
    ...(dependencies.prompts as object),
    select: async () => cancelled,
    isCancel: (value: unknown) => value === cancelled,
  } as unknown as InitDependencies["prompts"];

  await expect(
    runInit(undefined, { ...baseOptions, verbose: true }, dependencies),
  ).rejects.toThrow("exit");

  expect(writes).toEqual([]);
  expect(logs).toContain("cancel:Cancelled.");
});

test("me init and me init . write the same quick profile", async () => {
  const first = wizardDependencies({
    confirms: [false, true],
    detected: [{ name: "claude", displayName: "Claude Code" }],
    installed: ["claude"],
  });
  const second = wizardDependencies({
    confirms: [false, true],
    detected: [{ name: "claude", displayName: "Claude Code" }],
    installed: ["claude"],
  });

  await runInit(undefined, baseOptions, first.dependencies);
  await runInit(".", baseOptions, second.dependencies);

  expect(first.writes).toEqual(second.writes);
});

test("quick init enables MCP and CLI for every detected harness", async () => {
  const { dependencies, writes, selectCalls, outros } = wizardDependencies({
    confirms: [false, true],
    detected: [
      { name: "claude", displayName: "Claude Code" },
      { name: "codex", displayName: "Codex CLI" },
    ],
    installed: ["claude", "codex"],
  });

  await runInit("/repo", baseOptions, dependencies);

  expect(writes[0]).toEqual({
    scope: "/repo",
    profile: {
      mcp: {
        enabled: true,
        server: "https://api.memory.build",
        space: space.slug,
        harnesses: { claude: true, codex: true },
      },
      capture: { enabled: false, harnesses: {} },
      cli: {
        server: "https://api.memory.build",
        space: space.slug,
        harnesses: { claude: true, codex: true },
      },
    },
  });
  expect(selectCalls).toEqual([]);
  expect(outros).toEqual([
    "Configured /repo in /home/test/.config/me/config.yaml. Run 'me init --verbose' for advanced setup.",
  ]);
});

test("quick init uses its explicit server instead of the configured default", async () => {
  const { dependencies } = wizardDependencies({
    confirms: [false, true],
    detected: [{ name: "claude", displayName: "Claude Code" }],
    installed: ["claude"],
  });
  let requestedServer: string | undefined;
  dependencies.resolveCredentials = (server) => {
    requestedServer = server;
    return {
      server: server ?? "https://configured.example.com",
      loggedIn: true,
      activeSpace: undefined,
    };
  };

  await runInit(
    "/repo",
    { ...baseOptions, server: "https://self-hosted.example.com" },
    dependencies,
  );

  expect(requestedServer).toBe("https://self-hosted.example.com");
});

test("quick init defaults the space picker to the active space", async () => {
  const other = { slug: "other000000", name: "Other" };
  const { dependencies, selectCalls } = wizardDependencies({
    confirms: [false, true],
    selects: [space.slug],
    activeSpace: space.slug,
    user: fakeUser([space, other]),
    detected: [{ name: "claude", displayName: "Claude Code" }],
    installed: ["claude"],
  });

  await runInit("/repo", baseOptions, dependencies);

  expect(selectCalls[0]).toMatchObject({ initialValue: space.slug });
});

test("quick init offers shared capture with a private-tree note", async () => {
  const { dependencies, writes, logs, textCalls } = wizardDependencies({
    confirms: [true, true],
    texts: ["/share/projects/demo"],
    detected: [{ name: "claude", displayName: "Claude Code" }],
    installed: ["claude"],
  });

  await runInit("/repo", baseOptions, dependencies);

  expect(textCalls[0]).toMatchObject({
    initialValue: "/share/projects/demo",
  });
  expect(logs).toContain(
    "info:Use ~/projects/demo instead to capture sessions privately.",
  );
  expect(writes[0]).toMatchObject({
    profile: { capture: { enabled: true, tree: "/share/projects/demo" } },
  });
});

test("quick init prints missing integration instructions when declined", async () => {
  const { dependencies, logs } = wizardDependencies({
    confirms: [false, false, true],
    detected: [{ name: "codex", displayName: "Codex CLI" }],
  });

  await runInit("/repo", baseOptions, dependencies);

  expect(logs).toContain("info:Run 'me install codex' when you are ready.");
});
