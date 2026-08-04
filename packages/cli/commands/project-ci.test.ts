import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  buildCiInstallOptions,
  createCiInstallCommand,
  DEFAULT_SECRET_NAME,
  isEffectiveSpaceAdmin,
  parseGitHubRepo,
  renderWorkflow,
  validateCiInstallMode,
  writeWorkflow,
} from "./project-ci.ts";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("me ci install", () => {
  test("registers install beneath the ci command", () => {
    const command = createCiInstallCommand();
    expect(command.name()).toBe("ci");
    expect(command.commands.map((child) => child.name())).toContain("install");
    const install = command.commands.find(
      (child) => child.name() === "install",
    );
    expect(install?.options.some((option) => option.long === "--server")).toBe(
      true,
    );
  });

  test("parses GitHub remotes", () => {
    expect(parseGitHubRepo("git@github.com:acme/widgets.git")).toBe(
      "acme/widgets",
    );
    expect(parseGitHubRepo("https://github.com/acme/widgets")).toBe(
      "acme/widgets",
    );
    expect(parseGitHubRepo("git@gitlab.com:acme/widgets.git")).toBeUndefined();
  });

  test("renders a single-target workflow with explicit imports", () => {
    const workflow = renderWorkflow({
      secretName: DEFAULT_SECRET_NAME,
      space: "team-memory",
      tree: "/share/projects/widgets",
      server: "https://me.example.test",
    });
    expect(() => parse(workflow)).not.toThrow();
    expect(workflow).toContain("ME_API_KEY: ${{ secrets.ME_API_KEY }}");
    expect(workflow).toContain("ME_SPACE: team-memory");
    expect(workflow).toContain("ME_SERVER: https://me.example.test");
    expect(workflow).toContain("import git --tree /share/projects/widgets");
    expect(workflow).toContain(
      "import docs . --git-aware --prune --tree /share/projects/widgets",
    );
    expect(workflow).not.toContain("import ci");
  });

  test("does not bake ME_SERVER for the default server", () => {
    const workflow = renderWorkflow({
      secretName: DEFAULT_SECRET_NAME,
      space: "team-memory",
      tree: "/share/projects/widgets",
    });
    expect(workflow).not.toContain("ME_SERVER:");
  });

  test("validates workflow-only credential flags", () => {
    expect(
      buildCiInstallOptions({
        workflowOnly: true,
        server: "https://me.example.test",
      }),
    ).toMatchObject({
      workflowOnly: true,
      server: "https://me.example.test",
      secretName: DEFAULT_SECRET_NAME,
    });
    expect(() =>
      buildCiInstallOptions({ workflowOnly: true, createServiceAccount: true }),
    ).toThrow(/workflow-only/);
    expect(() => buildCiInstallOptions({ secretName: "not-valid" })).toThrow(
      /secret-name/,
    );
    expect(() => buildCiInstallOptions({ tree: "not a tree" })).toThrow(
      /--tree/,
    );
    expect(() => buildCiInstallOptions({ tree: "~/projects/widgets" })).toThrow(
      /--tree/,
    );
    expect(() => buildCiInstallOptions({ space: "not-a-slug" })).toThrow(
      /--space/,
    );
  });

  test("rejects non-interactive credential modes before any workflow write", () => {
    const opts = buildCiInstallOptions({ space: "abcdefghijkl" });
    expect(() => validateCiInstallMode(opts, false)).toThrow(
      "Non-interactive mode requires",
    );
  });

  test("does not replace a workflow before rejecting non-interactive credential mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "me-ci-ordering-"));
    temporaryDirectories.push(dir);
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/widgets.git"],
      {
        cwd: dir,
      },
    );
    const path = join(dir, ".github", "workflows", "me-import.yml");
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(path, "user-owned\n");
    const child = Bun.spawn(
      [
        process.execPath,
        join(process.cwd(), "packages", "cli", "index.ts"),
        "ci",
        "install",
        "--space",
        "abcdefghijkl",
        "--force",
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe("user-owned\n");
  });

  test("does not replace a workflow before failed scripted credential placement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "me-ci-placement-ordering-"));
    temporaryDirectories.push(dir);
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/widgets.git"],
      { cwd: dir },
    );
    const path = join(dir, ".github", "workflows", "me-import.yml");
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(path, "user-owned\n");
    const child = Bun.spawn(
      [
        process.execPath,
        join(process.cwd(), "packages", "cli", "index.ts"),
        "ci",
        "install",
        "--space",
        "abcdefghijkl",
        "--create-service-account",
        "--force",
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(dir, "config"),
          ME_NO_KEYCHAIN: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe("user-owned\n");
  });

  test("recognizes direct, group, and non-admin space listings", () => {
    expect(
      isEffectiveSpaceAdmin(
        [{ slug: "abcdefghijkl", admin: true }],
        "abcdefghijkl",
      ),
    ).toBe(true);
    expect(
      isEffectiveSpaceAdmin(
        [{ slug: "abcdefghijkl", admin: true }],
        "abcdefghijkl",
      ),
    ).toBe(true);
    expect(
      isEffectiveSpaceAdmin(
        [{ slug: "abcdefghijkl", admin: false }],
        "abcdefghijkl",
      ),
    ).toBe(false);
  });

  test("refuses an existing workflow unless forced, then replaces the whole file", () => {
    const dir = mkdtempSync(join(tmpdir(), "me-ci-"));
    temporaryDirectories.push(dir);
    const path = join(dir, ".github", "workflows", "me-import.yml");
    expect(writeWorkflow(path, "new\n", false)).toBe("created");
    expect(existsSync(path)).toBe(true);
    writeFileSync(path, "user-owned\n");
    expect(() => writeWorkflow(path, "replacement\n", false)).toThrow(
      /--force/,
    );
    expect(readFileSync(path, "utf8")).toBe("user-owned\n");
    expect(writeWorkflow(path, "replacement\n", true)).toBe("replaced");
    expect(readFileSync(path, "utf8")).toBe("replacement\n");
    const newPath = join(dir, ".github", "workflows", "new.yml");
    expect(writeWorkflow(newPath, "new\n", true)).toBe("created");
  });
});
