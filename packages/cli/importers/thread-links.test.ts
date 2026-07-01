/**
 * Tests for conversation thread-link stamping ($prev/$thread).
 */
import { describe, expect, test } from "bun:test";
import type { MemoryCreateParams } from "@memory.build/protocol/memory";
import {
  type GitLinkEntry,
  stampConversationLinks,
  stampGitPrevLinks,
} from "./thread-links.ts";

function payload(
  tree: string,
  name: string,
  meta: Record<string, unknown> = {},
): MemoryCreateParams {
  return { content: "x", tree, name, meta };
}

describe("stampConversationLinks", () => {
  const tree = "share.projects.foo.agent_sessions.sess1";

  test("stamps $thread on every message and $prev on all but the first", () => {
    const payloads = [
      payload(tree, "msg_a"),
      payload(tree, "msg_b"),
      payload(tree, "msg_c"),
    ];
    stampConversationLinks(payloads, "sess1");

    expect(payloads.map((p) => p.meta)).toEqual([
      { $thread: "sess1" },
      { $thread: "sess1", $prev: `/${tree.replace(/\./g, "/")}/msg_a` },
      { $thread: "sess1", $prev: `/${tree.replace(/\./g, "/")}/msg_b` },
    ]);
  });

  test("a single message gets $thread but no $prev", () => {
    const payloads = [payload(tree, "msg_only")];
    stampConversationLinks(payloads, "sess1");
    expect(payloads[0]?.meta).toEqual({ $thread: "sess1" });
  });

  test("preserves pre-existing meta", () => {
    const payloads = [
      payload(tree, "msg_a", { type: "agent_session", source_tool: "claude" }),
      payload(tree, "msg_b", { type: "agent_session" }),
    ];
    stampConversationLinks(payloads, "sess1");
    expect(payloads[0]?.meta).toMatchObject({
      type: "agent_session",
      source_tool: "claude",
      $thread: "sess1",
    });
    expect(payloads[1]?.meta?.$prev).toBe(`/${tree.replace(/\./g, "/")}/msg_a`);
  });

  test("$prev is the canonical leading-slash path of the previous message", () => {
    const payloads = [payload(tree, "msg_a"), payload(tree, "msg_b")];
    stampConversationLinks(payloads, "sess1");
    expect(payloads[1]?.meta?.$prev).toBe(
      "/share/projects/foo/agent_sessions/sess1/msg_a",
    );
  });

  test("is a no-op on an empty list", () => {
    expect(() => stampConversationLinks([], "sess1")).not.toThrow();
  });
});

describe("stampGitPrevLinks", () => {
  const tree = "share.projects.foo.git_history";
  const gitPath = (sha: string) => `/share/projects/foo/git_history/${sha}`;

  function entry(sha: string, firstParent: string | undefined): GitLinkEntry {
    return { payload: payload(tree, sha), firstParent };
  }

  test("links each commit to its first-parent path; root has none", () => {
    // newest-first walk order: c3 -> c2 -> c1(root)
    const entries = [
      entry("c3", "c2"),
      entry("c2", "c1"),
      entry("c1", undefined),
    ];
    stampGitPrevLinks(entries, {
      skipped: new Map(),
      inSet: new Set(["c1", "c2", "c3"]),
    });
    expect(entries[0]?.payload.meta?.$prev).toBe(gitPath("c2"));
    expect(entries[1]?.payload.meta?.$prev).toBe(gitPath("c1"));
    expect(entries[2]?.payload.meta).toEqual({}); // root: no $prev
  });

  test("steps through a dropped (boilerplate) merge to the nearest ancestor", () => {
    // c3's first parent is merge m (dropped); m's first parent is c2 (kept).
    const entries = [entry("c3", "m"), entry("c2", "c1")];
    stampGitPrevLinks(entries, {
      skipped: new Map([["m", "c2"]]),
      inSet: new Set(["c1", "c2", "c3"]),
    });
    expect(entries[0]?.payload.meta?.$prev).toBe(gitPath("c2"));
  });

  test("gating on inSet omits a $prev below the import floor", () => {
    // c2's parent c1 was not imported (bounded first import) → no $prev.
    const entries = [entry("c3", "c2"), entry("c2", "c1")];
    stampGitPrevLinks(entries, {
      skipped: new Map(),
      inSet: new Set(["c2", "c3"]),
    });
    expect(entries[0]?.payload.meta?.$prev).toBe(gitPath("c2"));
    expect(entries[1]?.payload.meta).toEqual({}); // c1 not imported → omitted
  });

  test("without inSet (incremental) links to an out-of-batch parent", () => {
    // Incremental: c4's parent c3 is the high-water commit, already imported.
    const entries = [entry("c4", "c3")];
    stampGitPrevLinks(entries, { skipped: new Map() });
    expect(entries[0]?.payload.meta?.$prev).toBe(gitPath("c3"));
  });
});
