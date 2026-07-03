import { describe, expect, test } from "bun:test";
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

  test("rejects a tree root with illegal characters", () => {
    expect(() => buildOptions({ treeRoot: "bad space" })).toThrow(
      "Invalid --tree-root",
    );
  });

  test("a --project run picks up the .me tree as projectTree (matches the hook)", () => {
    const config = buildOptions(
      { project: "/repo" },
      { projectTree: "/share/projects/foo" },
    );
    expect(config.write.projectTree).toBe("/share/projects/foo");
    // The parent+slug fallback is still the private default (unused when
    // projectTree wins, but reported/available for sessions outside the tree).
    expect(config.write.treeRoot).toBe("~/projects");
  });

  test("a bare (multi-project) sweep ignores the .me tree — parent+slug fallback", () => {
    const config = buildOptions({}, { projectTree: "/share/projects/foo" });
    expect(config.write.projectTree).toBeUndefined();
    expect(config.write.treeRoot).toBe("~/projects");
  });

  test("an explicit --tree-root overrides the .me tree even for a --project run", () => {
    const config = buildOptions(
      { project: "/repo", treeRoot: "share.work" },
      { projectTree: "/share/projects/foo" },
    );
    expect(config.write.projectTree).toBeUndefined();
    expect(config.write.treeRoot).toBe("share.work");
  });

  test("no creds → no projectTree (private default governs)", () => {
    const config = buildOptions({ project: "/repo" });
    expect(config.write.projectTree).toBeUndefined();
    expect(config.write.treeRoot).toBe("~/projects");
  });
});
