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
  displayTree,
  type MemoryPointerSpec,
} from "./memory-pointer.ts";

const CLAUDE: MemoryPointerSpec = {
  filename: "CLAUDE.md",
  managedBy: "me project init",
  agentLabel: "Claude Code",
};
const OPENCODE: MemoryPointerSpec = {
  filename: "AGENTS.md",
  managedBy: "me project init",
  agentLabel: "OpenCode",
};

describe("buildMemoryPointerSection", () => {
  test("embeds the managing command in the start marker", () => {
    expect(buildMemoryPointerSection(CLAUDE, "share.projects.foo")).toContain(
      "<!-- memory-engine:start (managed by `me project init`) -->",
    );
    expect(buildMemoryPointerSection(OPENCODE, "share.projects.foo")).toContain(
      "<!-- memory-engine:start (managed by `me project init`) -->",
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
    const out = buildMemoryPointerSection(OPENCODE, "/share/projects/foo");
    expect(out).toContain("    /share/projects/foo");
    expect(out).toContain("`/share/projects/foo/agent_sessions`");
    expect(out).toContain("`/share/projects/foo/git_history`");
  });

  test("a dotted .me tree renders in clean slash form (no mixed separators)", () => {
    const out = buildMemoryPointerSection(OPENCODE, "share.projects.foo");
    expect(out).toContain("    /share/projects/foo");
    expect(out).toContain("`/share/projects/foo/agent_sessions`");
    expect(out).toContain("`/share/projects/foo/git_history`");
    expect(out).not.toContain("share.projects.foo/");
  });

  test("stray separators are normalized away (no // in rendered paths)", () => {
    const out = buildMemoryPointerSection(OPENCODE, "/share/projects/foo/");
    expect(out).toContain("`/share/projects/foo/agent_sessions`");
    expect(out).not.toContain("//");
  });

  test("a private ~ tree renders with quoted shell usage", () => {
    const out = buildMemoryPointerSection(CLAUDE, "~/projects/foo");
    expect(out).toContain("    ~/projects/foo");
    expect(out).toContain("`~/projects/foo/agent_sessions`");
    // The shell example quotes the tree so `~` survives the user's shell.
    expect(out).toContain(`--tree '~/projects/foo'`);
  });

  test("displayTree canonicalizes lenient forms", () => {
    expect(displayTree("share.projects.foo")).toBe("/share/projects/foo");
    expect(displayTree("/share/projects/foo")).toBe("/share/projects/foo");
    expect(displayTree("~/projects/foo")).toBe("~/projects/foo");
    expect(displayTree("~.projects.foo")).toBe("~/projects/foo");
    expect(displayTree("~")).toBe("~");
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
