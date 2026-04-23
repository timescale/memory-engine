/**
 * Tests for session transcript rendering.
 */
import { describe, expect, test } from "bun:test";
import { renderSessionContent, synthesizeTitle } from "./transcript.ts";
import type { ImportedSession } from "./types.ts";

function baseSession(): ImportedSession {
  return {
    tool: "claude",
    sessionId: "343a75a0-8037-4579-8b26-805a3371f3dc",
    cwd: "/Users/test/project",
    gitBranch: "main",
    gitCommit: "abcdef0123456789",
    toolVersion: "2.1.107",
    model: "claude-opus-4-5",
    provider: "anthropic",
    sourceFile: "/path/to/session.jsonl",
    startedAt: "2026-04-14T17:19:23.498Z",
    endedAt: "2026-04-14T18:45:12.000Z",
    sourceModifiedAt: "2026-04-14T18:45:12.000Z",
    lastMessageId: "msg-last",
    messageCounts: { user: 2, assistant: 2, tool_calls: 1 },
    turns: [
      {
        role: "user",
        text: "Help me debug the embedding worker",
        timestamp: "2026-04-14T17:19:23.498Z",
      },
      {
        role: "reasoning",
        text: "Thinking about the embedding worker...",
        timestamp: "2026-04-14T17:19:25.000Z",
      },
      {
        role: "assistant",
        text: "Let me look at the worker code.",
        timestamp: "2026-04-14T17:19:28.000Z",
      },
      {
        role: "tool_call",
        text: "read(file.ts)",
        toolName: "read",
        timestamp: "2026-04-14T17:19:30.000Z",
      },
      {
        role: "tool_result",
        text: "file contents here",
        toolName: "read",
        timestamp: "2026-04-14T17:19:31.000Z",
      },
      {
        role: "user",
        text: "What do you see?",
        timestamp: "2026-04-14T17:20:00.000Z",
      },
      {
        role: "assistant",
        text: "The worker polls every 10s.",
        timestamp: "2026-04-14T17:20:05.000Z",
      },
    ],
  };
}

describe("synthesizeTitle", () => {
  test("prefers explicit title", () => {
    const s = baseSession();
    s.title = "A Clear Title";
    expect(synthesizeTitle(s)).toBe("A Clear Title");
  });

  test("falls back to first user turn, single-lined and truncated", () => {
    const s = baseSession();
    s.turns[0] = {
      role: "user",
      text: "Help me\n\nwith  a   multi-line\nmessage".repeat(5),
    };
    const title = synthesizeTitle(s);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title).not.toContain("\n");
  });

  test("falls back to a generic session label with no user turns", () => {
    const s = baseSession();
    s.turns = [];
    expect(synthesizeTitle(s)).toContain("claude session");
  });
});

describe("renderSessionContent — default (filtered)", () => {
  test("includes user and assistant text, excludes reasoning/tool", () => {
    const body = renderSessionContent(baseSession(), { fullTranscript: false });
    expect(body).toContain("Help me debug the embedding worker");
    expect(body).toContain("The worker polls every 10s.");
    expect(body).not.toContain("Thinking about the embedding worker");
    expect(body).not.toContain("read(file.ts)");
    expect(body).not.toContain("file contents here");
  });

  test("renders metadata lines", () => {
    const body = renderSessionContent(baseSession(), { fullTranscript: false });
    expect(body).toContain("Tool: Claude v2.1.107");
    expect(body).toContain("Model: anthropic/claude-opus-4-5");
    expect(body).toContain("Project: /Users/test/project");
    expect(body).toContain("Branch: main @ abcdef0");
  });
});

describe("renderSessionContent — full transcript", () => {
  test("includes reasoning, tool calls, tool results", () => {
    const body = renderSessionContent(baseSession(), { fullTranscript: true });
    expect(body).toContain("Thinking about the embedding worker");
    expect(body).toContain("read(file.ts)");
    expect(body).toContain("file contents here");
  });
});
