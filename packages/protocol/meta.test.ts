import { describe, expect, test } from "bun:test";
import { META_NEXT, META_PREV, META_THREAD, memoryPath } from "./meta.ts";

describe("reserved meta keys", () => {
  test("are the documented $-prefixed literals", () => {
    expect(META_PREV).toBe("$prev");
    expect(META_NEXT).toBe("$next");
    expect(META_THREAD).toBe("$thread");
  });
});

describe("memoryPath", () => {
  test("renders a dotted tree + name as a canonical leading-slash path", () => {
    expect(memoryPath("share.projects.foo.agent_sessions.bar", "msg_1")).toBe(
      "/share/projects/foo/agent_sessions/bar/msg_1",
    );
    expect(memoryPath("share.projects.foo.git_history", "abc123")).toBe(
      "/share/projects/foo/git_history/abc123",
    );
  });

  test("handles the root tree", () => {
    expect(memoryPath("", "note")).toBe("/note");
  });

  test("is lenient on separators and leading/trailing separators", () => {
    for (const tree of [
      "share/auth",
      "share.auth",
      "/share/auth",
      "share.auth.",
      "//share//auth//",
    ]) {
      expect(memoryPath(tree, "x")).toBe("/share/auth/x");
    }
  });
});
