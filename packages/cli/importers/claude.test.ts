/**
 * Claude importer fixture tests.
 *
 * Exercises the full parse pipeline against checked-in fixtures that
 * cover normal sessions, sidechains, meta/local-command turns, thinking
 * blocks, and tool_use/tool_result.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  claudeImporter,
  sanitizeUserText,
  unwrapSdkReplayBundle,
} from "./claude.ts";
import type {
  ConversationMessage,
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

/** Collect text from all `text` blocks in a user-role message. */
function userTextsOf(messages: ConversationMessage[]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) =>
      m.blocks.filter((b) => b.kind === "text").map((b) => b.text),
    );
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

  test("filters out isMeta and local-command wrappers from user messages", async () => {
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    expect(s).toBeDefined();
    if (!s) return;
    const userTexts = userTextsOf(s.messages);
    expect(userTexts).toContain(
      "Please refactor the embedding worker to use a claims-based scheduler.",
    );
    expect(userTexts).toContain("Thanks, that's what I needed.");
    expect(userTexts.some((t) => t.includes("local-command-caveat"))).toBe(
      false,
    );
  });

  test("captures thinking and tool_use/tool_result blocks on messages", async () => {
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    expect(s).toBeDefined();
    if (!s) return;
    const allBlocks = s.messages.flatMap((m) => m.blocks);
    expect(allBlocks.some((b) => b.kind === "thinking")).toBe(true);
    expect(
      allBlocks.some((b) => b.kind === "tool_use" && b.toolName === "read"),
    ).toBe(true);
    expect(allBlocks.some((b) => b.kind === "tool_result")).toBe(true);
  });

  test("uses event uuid as message id and event timestamp as message timestamp", async () => {
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    expect(s).toBeDefined();
    if (!s) return;
    // Messages are in source order: user-1, asst-1, user-2, asst-2, user-3.
    // (meta, synthetic, and wrap-* events are dropped.)
    const ids = s.messages.map((m) => m.messageId);
    expect(ids).toEqual(["user-1", "asst-1", "user-2", "asst-2", "user-3"]);
    expect(s.messages[0]?.timestamp).toBe("2026-04-01T10:00:01.000Z");
    expect(s.messages[s.messages.length - 1]?.timestamp).toBe(
      "2026-04-01T10:00:10.000Z",
    );
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

  test("sanitizeUserText drops replay bundles whose extracted Human payload is just a tool result", () => {
    const bundle =
      "Assistant: Previous answer\n" +
      '[Tool Use: bash({"command":"git status"})]\n\n' +
      "Human: [Tool Result for toolu_abc: clean working tree]";
    expect(sanitizeUserText(bundle)).toBeNull();
  });

  test("sanitizeUserText drops request interrupted notifications", () => {
    expect(sanitizeUserText("[Request interrupted by user]")).toBeNull();
    expect(
      sanitizeUserText("[Request interrupted by user for tool use]"),
    ).toBeNull();
  });

  test("sanitizeUserText drops task notifications", () => {
    const notification =
      "<task-notification>\n" +
      "<task-id>abc</task-id>\n" +
      "<status>completed</status>\n" +
      "</task-notification>\n" +
      "Read the output file to retrieve the result: /tmp/abc.output";
    expect(sanitizeUserText(notification)).toBeNull();
  });

  test("sanitizeUserText strips generated reminder suffixes from real prompts", () => {
    const prompt =
      "Please rebase the PR again.\n" +
      "<system-reminder>\n" +
      "Your operational mode has changed from plan to build.\n" +
      "</system-reminder>";
    expect(sanitizeUserText(prompt)).toBe("Please rebase the PR again.");
  });

  test("sanitizeUserText strips leading ultrawork wrapper and keeps trailing prompt", () => {
    const prompt =
      "Human: <ultrawork-mode>\n" +
      "be extremely careful\n" +
      "</ultrawork-mode>\n\n---\n\nlooks good! ulw";
    expect(sanitizeUserText(prompt)).toBe("looks good! ulw");
  });

  test("sanitizeUserText drops sdk-ts wrapped command output", () => {
    const output =
      'Human: Error: unknown command "ghost" for "ghost"\n' +
      "Run 'ghost --help' for usage.\n---\n" +
      'Error: unknown command "upgrade" for "ghost"\n' +
      "Run 'ghost --help' for usage.\n";
    expect(sanitizeUserText(output)).toBeNull();
  });

  test("sanitizeUserText drops sdk-ts wrapped progress output", () => {
    const output =
      "Human: │\n" +
      "●  Importing codex sessions from /tmp (dry run)\n" +
      "│\n" +
      "◆  Would import 0 new, 0 updated\n";
    expect(sanitizeUserText(output)).toBeNull();
  });

  test("sanitizeUserText drops sdk-ts wrapped linter output", () => {
    const output =
      "Human:        │                          ------------                      \n\n" +
      "Skipped 1 suggested fixes.\n" +
      "Checked 236 files in 73ms. Fixed 5 files.\n" +
      'error: script "check" exited with code 1\n';
    expect(sanitizeUserText(output)).toBeNull();
  });

  test("drops SDK wrapper cycles and No-response-requested acks", async () => {
    // When a hook blocks a tool call, the Claude SDK inserts an isMeta
    // "Continue..." user message, a <synthetic> assistant "No response
    // requested." message, and a replay user message that re-serializes
    // the prior assistant turn + tool use as plain text. All three share
    // a promptId with the meta event and must be filtered out.
    //
    // Separately, the sdk-ts entrypoint also emits real (non-synthetic)
    // "No response requested." assistant turns that share the text but
    // have a normal model + end_turn stop reason — also noise.
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    expect(s).toBeDefined();
    if (!s) return;
    const allText = s.messages
      .flatMap((m) => m.blocks.map((b) => b.text))
      .join("\n");
    expect(allText).not.toContain("No response requested.");
    expect(allText).not.toContain("Assistant: The worker polls");
    expect(allText).not.toContain("[Tool Use:");
    expect(allText).not.toContain("[Tool Result for");
    const ids = s.messages.map((m) => m.messageId);
    expect(ids).not.toContain("wrap-assist-1"); // <synthetic> ack
    expect(ids).not.toContain("noresp-ack-1"); // real-model sdk-ts ack
    const userCount = s.messages.filter((m) => m.role === "user").length;
    const assistantCount = s.messages.filter(
      (m) => m.role === "assistant",
    ).length;
    // Real user events: user-1, user-2 (tool_result only), user-3 → 3 messages.
    expect(userCount).toBe(3);
    // Real assistant events: asst-1, asst-2 → 2 messages.
    expect(assistantCount).toBe(2);
  });
});
