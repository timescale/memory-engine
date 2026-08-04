import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { buildOptions } from "./import.ts";

describe("buildOptions", () => {
  test("defaults to the PRIVATE tree root and agent_sessions node name", () => {
    const config = buildOptions({});

    expect(config.write.treeRoot).toBe("~/projects");
    expect(config.write.sessionsNodeName).toBe("agent_sessions");
  });

  test("accepts a custom sessions node name", () => {
    const config = buildOptions({ sessionsNodeName: "sessions" });

    expect(config.write.sessionsNodeName).toBe("sessions");
  });

  test("rejects invalid sessions node names", () => {
    expect(() => buildOptions({ sessionsNodeName: "agent-sessions" })).toThrow(
      "Invalid --sessions-node-name: 'agent-sessions'. Must match [a-z0-9_]+",
    );
  });

  test("accepts a ~ (home) tree root and other lenient forms", () => {
    expect(buildOptions({ treeRoot: "~" }).write.treeRoot).toBe("~");
    expect(buildOptions({ treeRoot: "~.work" }).write.treeRoot).toBe("~.work");
    expect(buildOptions({ treeRoot: "~/work" }).write.treeRoot).toBe("~/work");
    expect(buildOptions({ treeRoot: "share.projects" }).write.treeRoot).toBe(
      "share.projects",
    );
  });

  test("rejects a shell-expanded ~ tree root before writes start", () => {
    expect(() => buildOptions({ treeRoot: homedir() })).toThrow(
      "looks like your shell expanded '~'",
    );
  });

  test("rejects a tree root with illegal characters", () => {
    expect(() => buildOptions({ treeRoot: "bad space" })).toThrow(
      "Invalid --tree-root",
    );
  });

  test("never sets a run-level tree", () => {
    expect(buildOptions({ project: "/repo" }).write.tree).toBeUndefined();
    expect(buildOptions({}).write.tree).toBeUndefined();
  });
});
