import { describe, expect, test } from "bun:test";
import { HOOK_EVENT_NAMES, SESSIONS_NODE } from "./capture.ts";

describe("Claude capture hook definitions", () => {
  test("registers only the transcript flush events", () => {
    expect(HOOK_EVENT_NAMES).toEqual(["stop", "session-end"]);
  });

  test("uses the shared sessions leaf", () => {
    expect(SESSIONS_NODE).toBe("agent_sessions");
  });
});
