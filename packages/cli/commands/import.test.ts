import { describe, expect, test } from "bun:test";
import { buildOptions } from "./import.ts";

describe("buildOptions", () => {
  test("defaults imported session node name to agent_sessions", () => {
    const config = buildOptions({});

    expect(config.write.treeRoot).toBe("share.projects");
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
});
