/**
 * Claude importer fixture tests.
 *
 * Exercises the full parse pipeline against checked-in fixtures that
 * cover normal sessions, sidechains, meta/local-command turns, thinking
 * blocks, and tool_use/tool_result.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { claudeImporter, unwrapSdkReplayBundle } from "./claude.ts";
import type {
  ImportedSession,
  ImporterOptions,
  ImporterStats,
} from "./types.ts";

const FIXTURE_DIR = join(import.meta.dir, "__fixtures__", "claude");

function baseOptions(
  overrides: Partial<ImporterOptions> = {},
): ImporterOptions {
  return {
    source: FIXTURE_DIR,
    fullTranscript: false,
    includeSidechains: false,
    includeTempCwd: false,
    includeTrivial: true,
    ...overrides,
  };
}

async function collect(
  options: ImporterOptions,
): Promise<{ sessions: ImportedSession[]; stats: ImporterStats }> {
  const stats: ImporterStats = {
    totalFiles: 0,
    yielded: 0,
    skipped: {},
    errors: [],
  };
  const sessions: ImportedSession[] = [];
  for await (const s of claudeImporter.discoverSessions(options, stats)) {
    sessions.push(s);
  }
  return { sessions, stats };
}

describe("claude importer", () => {
  test("skips sidechains by default", async () => {
    const { sessions, stats } = await collect(baseOptions());
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.isSidechain).toBeUndefined();
    expect(stats.skipped.sidechain).toBe(1);
  });

  test("includes sidechains with --include-sidechains", async () => {
    const { sessions } = await collect(
      baseOptions({ includeSidechains: true }),
    );
    expect(sessions).toHaveLength(2);
    expect(sessions.some((s) => s.isSidechain === true)).toBe(true);
  });

  test("captures session-level metadata from the first event", async () => {
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    expect(s).toBeDefined();
    if (!s) return;
    expect(s.sessionId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(s.cwd).toBe("/Users/test/project");
    expect(s.gitBranch).toBe("main");
    expect(s.toolVersion).toBe("2.1.0");
    expect(s.model).toBe("claude-opus-4-5");
    expect(s.provider).toBe("anthropic");
  });

  test("filters out isMeta and local-command wrappers from user turns", async () => {
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    expect(s).toBeDefined();
    if (!s) return;
    // Real user turns: "Please refactor..." and "Thanks, ..."
    // The isMeta "<local-command-caveat>..." should be dropped.
    const userTexts = s.turns
      .filter((t) => t.role === "user")
      .map((t) => t.text);
    expect(userTexts).toContain(
      "Please refactor the embedding worker to use a claims-based scheduler.",
    );
    expect(userTexts).toContain("Thanks, that's what I needed.");
    expect(userTexts.some((t) => t.includes("local-command-caveat"))).toBe(
      false,
    );
  });

  test("captures thinking and tool_use/tool_result turns", async () => {
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    expect(s).toBeDefined();
    if (!s) return;
    expect(s.turns.some((t) => t.role === "reasoning")).toBe(true);
    expect(
      s.turns.some((t) => t.role === "tool_call" && t.toolName === "read"),
    ).toBe(true);
    expect(s.turns.some((t) => t.role === "tool_result")).toBe(true);
    expect(s.messageCounts.tool_calls).toBe(1);
  });

  test("tracks lastMessageId and timestamps from events", async () => {
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    expect(s).toBeDefined();
    if (!s) return;
    expect(s.lastMessageId).toBe("user-3");
    // startedAt is the timestamp of the first real (non-meta) message.
    expect(s.startedAt).toBe("2026-04-01T10:00:01.000Z");
    expect(s.endedAt).toBe("2026-04-01T10:00:10.000Z");
  });

  test("unwrapSdkReplayBundle returns plain text unchanged", () => {
    expect(unwrapSdkReplayBundle("How do I refactor this?")).toBe(
      "How do I refactor this?",
    );
    expect(unwrapSdkReplayBundle("")).toBe("");
  });

  test("unwrapSdkReplayBundle extracts new prompt from bundle style", () => {
    const bundle =
      "Human: First prompt\n\nAssistant: First answer\n\n" +
      "Human: Second prompt\n\nAssistant: Second answer\n\n" +
      "Human: Please create a PR for this";
    expect(unwrapSdkReplayBundle(bundle)).toBe("Please create a PR for this");
  });

  test("unwrapSdkReplayBundle strips leading Human: when no separator", () => {
    // Original first prompt wrapped by SDK, no replay history yet.
    expect(unwrapSdkReplayBundle("Human: I would like to modify foo")).toBe(
      "I would like to modify foo",
    );
  });

  test("unwrapSdkReplayBundle drops serialized prior assistant turns", () => {
    expect(
      unwrapSdkReplayBundle(
        "[Assistant: ## Summary\nRewrote the worker to use a queue.]",
      ),
    ).toBeNull();
    expect(
      unwrapSdkReplayBundle('[Tool Use: bash({"command":"ls"})]'),
    ).toBeNull();
    expect(
      unwrapSdkReplayBundle("[Tool Result for toolu_abc: output text]"),
    ).toBeNull();
  });

  test("unwrapSdkReplayBundle drops Assistant:-only preamble with no new prompt", () => {
    expect(
      unwrapSdkReplayBundle("Assistant: All helpers behave correctly."),
    ).toBeNull();
  });

  test("unwrapSdkReplayBundle extracts new prompt from You-are system-prompt bundle", () => {
    // opencode-claude-max-proxy pattern: system prompt + history stuffed
    // into the user event as one large text block, real prompt at the end.
    const bundle =
      "You are Claude Code, Anthropic's official CLI for Claude.\n" +
      "\n" +
      "You are OpenCode, the best coding agent on the planet.\n" +
      "\n" +
      "IMPORTANT: When using the task/Task tool, the subagent_type " +
      "parameter must be one of these exact values (case-sensitive, " +
      "lowercase): general, explore. Do NOT capitalize or modify these names.\n" +
      "\n" +
      "Human: Please review PR #123. Does everything look correct?";
    expect(unwrapSdkReplayBundle(bundle)).toBe(
      "Please review PR #123. Does everything look correct?",
    );
  });

  test("unwrapSdkReplayBundle drops You-are system-prompt with no new prompt", () => {
    expect(
      unwrapSdkReplayBundle(
        "You are Claude Code, Anthropic's official CLI for Claude.",
      ),
    ).toBeNull();
  });

  test("unwrapSdkReplayBundle extracts new prompt from Assistant:-prefixed bundle", () => {
    const bundle =
      "Assistant: All helpers behave correctly.\n\n" +
      "Files changed:\n- edited /tmp/install.sh\n\n" +
      "Human: How can I test a non-interactive terminal?";
    expect(unwrapSdkReplayBundle(bundle)).toBe(
      "How can I test a non-interactive terminal?",
    );
  });

  test("drops SDK wrapper cycles (synthetic assistant + replay user)", async () => {
    // When a hook blocks a tool call, the Claude SDK inserts an isMeta
    // "Continue..." user message, a <synthetic> assistant "No response
    // requested." message, and a replay user message that re-serializes
    // the prior assistant turn + tool use as plain text. All three share
    // a promptId with the meta event and must be filtered out.
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    expect(s).toBeDefined();
    if (!s) return;
    const allText = s.turns.map((t) => t.text).join("\n");
    expect(allText).not.toContain("No response requested.");
    expect(allText).not.toContain("Assistant: The worker polls");
    expect(allText).not.toContain("[Tool Use:");
    expect(allText).not.toContain("[Tool Result for");
    // Real user turns remain; the replay is gone.
    expect(s.messageCounts.user).toBe(2);
    // Real assistant turns remain; the synthetic one is gone.
    expect(s.messageCounts.assistant).toBe(2);
  });
});
