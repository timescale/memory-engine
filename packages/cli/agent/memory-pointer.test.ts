/**
 * Tests for the shared agent memory-pointer block builder.
 *
 * Only the pure `buildMemoryPointerSection` is covered here — the writer side
 * (`writeMemoryPointer`) depends on cwd / git / credentials and is exercised via
 * the per-agent init flows.
 */
import { describe, expect, test } from "bun:test";
import {
  buildMemoryPointerSection,
  type MemoryPointerSpec,
} from "./memory-pointer.ts";

const CLAUDE: MemoryPointerSpec = {
  filename: "CLAUDE.md",
  managedBy: "me claude init",
  agentLabel: "Claude Code",
};
const OPENCODE: MemoryPointerSpec = {
  filename: "AGENTS.md",
  managedBy: "me opencode init",
  agentLabel: "OpenCode",
};

describe("buildMemoryPointerSection", () => {
  test("embeds the managing command in the start marker", () => {
    expect(buildMemoryPointerSection(CLAUDE, "share.projects.foo")).toContain(
      "<!-- memory-engine:start (managed by `me claude init`) -->",
    );
    expect(buildMemoryPointerSection(OPENCODE, "share.projects.foo")).toContain(
      "<!-- memory-engine:start (managed by `me opencode init`) -->",
    );
  });

  test("is delimited by the shared end marker", () => {
    expect(buildMemoryPointerSection(OPENCODE, "share.projects.foo")).toContain(
      "<!-- memory-engine:end -->",
    );
  });

  test("uses the agent label in the body copy", () => {
    expect(buildMemoryPointerSection(OPENCODE, "share.projects.foo")).toContain(
      "captured/imported OpenCode",
    );
    expect(buildMemoryPointerSection(CLAUDE, "share.projects.foo")).toContain(
      "captured/imported Claude Code",
    );
  });

  test("renders the project tree, sessions, and git-history paths", () => {
    const out = buildMemoryPointerSection(OPENCODE, "share.projects.foo");
    expect(out).toContain("    share.projects.foo");
    expect(out).toContain("`share.projects.foo.agent_sessions`");
    expect(out).toContain("`share.projects.foo.git_history`");
  });

  test("notes the space when provided", () => {
    expect(
      buildMemoryPointerSection(OPENCODE, "share.projects.foo", "eng123"),
    ).toContain("Memory Engine (space `eng123`)");
    expect(buildMemoryPointerSection(OPENCODE, "share.projects.foo")).toContain(
      "stored in Memory Engine under the tree",
    );
  });
});
