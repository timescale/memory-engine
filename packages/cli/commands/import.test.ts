import { describe, expect, test } from "bun:test";
import { buildOptions } from "./import.ts";

describe("buildOptions", () => {
  test("defaults imported session node name to agent_sessions", () => {
    const config = buildOptions({});

    expect(config.write.treeRoot).toBe("projects");
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
});
