import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
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
  parseGitHubRepo,
  renderWorkflow,
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
    expect(buildCiInstallOptions({ workflowOnly: true })).toMatchObject({
      workflowOnly: true,
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
    expect(() => buildCiInstallOptions({ space: "not-a-slug" })).toThrow(
      /--space/,
    );
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
  });
});
