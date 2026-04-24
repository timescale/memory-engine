/**
 * Tests for per-message content rendering.
 */
import { describe, expect, test } from "bun:test";
import { renderMessageContent, synthesizeTitle } from "./transcript.ts";
import type { ConversationMessage, ImportedSession } from "./types.ts";

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
    messages: [
      {
        messageId: "u1",
        timestamp: "2026-04-14T17:19:23.498Z",
        role: "user",
        blocks: [{ kind: "text", text: "Help me debug the embedding worker" }],
      },
      {
        messageId: "a1",
        timestamp: "2026-04-14T17:19:28.000Z",
        role: "assistant",
        blocks: [
          { kind: "thinking", text: "Thinking about the embedding worker..." },
          { kind: "text", text: "Let me look at the worker code." },
          { kind: "tool_use", text: "read(file.ts)", toolName: "read" },
        ],
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

  test("falls back to first user message text, single-lined and truncated", () => {
    const s = baseSession();
    s.messages[0] = {
      messageId: "u1",
      timestamp: "2026-04-14T17:19:23.498Z",
      role: "user",
      blocks: [
        {
          kind: "text",
          text: "Help me\n\nwith  a   multi-line\nmessage".repeat(5),
        },
      ],
    };
    const title = synthesizeTitle(s);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title).not.toContain("\n");
  });

  test("falls back to a generic session label when there are no user messages", () => {
    const s = baseSession();
    s.messages = [];
    expect(synthesizeTitle(s)).toContain("claude session");
  });
});

function userMessage(): ConversationMessage {
  return {
    messageId: "u1",
    timestamp: "2026-04-14T17:19:23.498Z",
    role: "user",
    blocks: [{ kind: "text", text: "Help me debug the embedding worker" }],
  };
}

function assistantMessage(): ConversationMessage {
  return {
    messageId: "a1",
    timestamp: "2026-04-14T17:19:28.000Z",
    role: "assistant",
    blocks: [
      { kind: "thinking", text: "Thinking..." },
      { kind: "text", text: "Let me look at the worker code." },
      { kind: "tool_use", text: "read(file.ts)", toolName: "read" },
    ],
  };
}

describe("renderMessageContent — default (text blocks only)", () => {
  test("keeps only text blocks for user messages", () => {
    const content = renderMessageContent(userMessage(), {
      fullTranscript: false,
    });
    expect(content).toBe("Help me debug the embedding worker");
  });

  test("drops thinking + tool_use blocks for assistant messages", () => {
    const content = renderMessageContent(assistantMessage(), {
      fullTranscript: false,
    });
    expect(content).toBe("Let me look at the worker code.");
  });

  test("returns null for a message with no text blocks", () => {
    const m: ConversationMessage = {
      messageId: "tr",
      timestamp: "2026-04-14T17:19:32.000Z",
      role: "user",
      blocks: [{ kind: "tool_result", text: "output text" }],
    };
    expect(renderMessageContent(m, { fullTranscript: false })).toBeNull();
  });
});

describe("renderMessageContent — full transcript", () => {
  test("joins all block kinds with blank-line separators", () => {
    const content = renderMessageContent(assistantMessage(), {
      fullTranscript: true,
    });
    expect(content).toContain("Thinking...");
    expect(content).toContain("Let me look at the worker code.");
    expect(content).toContain("read(file.ts)");
    expect(content?.split("\n\n")).toHaveLength(3);
  });

  test("keeps tool_result messages in full mode", () => {
    const m: ConversationMessage = {
      messageId: "tr",
      timestamp: "2026-04-14T17:19:32.000Z",
      role: "tool_result",
      blocks: [{ kind: "tool_result", text: "output text" }],
    };
    expect(renderMessageContent(m, { fullTranscript: true })).toBe(
      "output text",
    );
  });
});
