/**
 * Unit tests for Claude Code hook capture logic.
 */
import { describe, expect, test } from "bun:test";
import type { EngineClient } from "@memory.build/client";
import {
  buildMeta,
  captureHookEvent,
  deriveProject,
  extractContent,
  type HookEvent,
  metaTypeForEvent,
} from "./capture.ts";
import type { PluginConfig } from "./config.ts";

const BASE_EVENT = {
  session_id: "sess-abc",
  cwd: "/tmp/myproj",
  hook_event_name: "UserPromptSubmit",
  transcript_path: "/tmp/transcript.jsonl",
};

const CONFIG: PluginConfig = {
  server: "https://api.example.com",
  engine: "eng123",
  api_key: "me.eng123.aaa.bbb",
  tree_prefix: "claude_code.sessions",
  mode: "plugin",
};

// =============================================================================
// extractContent
// =============================================================================

describe("extractContent", () => {
  test("returns prompt for user-prompt-submit", () => {
    const event: HookEvent = { ...BASE_EVENT, prompt: "hello world" };
    expect(extractContent(event, "user-prompt-submit")).toBe("hello world");
  });

  test("returns null for empty prompt", () => {
    const event: HookEvent = { ...BASE_EVENT, prompt: "" };
    expect(extractContent(event, "user-prompt-submit")).toBeNull();
  });

  test("returns null for whitespace-only prompt", () => {
    const event: HookEvent = { ...BASE_EVENT, prompt: "   \n\t  " };
    expect(extractContent(event, "user-prompt-submit")).toBeNull();
  });

  test("returns last_assistant_message for stop", () => {
    const event: HookEvent = {
      ...BASE_EVENT,
      last_assistant_message: "final response",
    };
    expect(extractContent(event, "stop")).toBe("final response");
  });

  test("returns null for null last_assistant_message", () => {
    const event: HookEvent = {
      ...BASE_EVENT,
      last_assistant_message: null,
    };
    expect(extractContent(event, "stop")).toBeNull();
  });

  test("returns null for missing last_assistant_message", () => {
    const event: HookEvent = { ...BASE_EVENT };
    expect(extractContent(event, "stop")).toBeNull();
  });

  test("preserves internal whitespace in content", () => {
    const event: HookEvent = {
      ...BASE_EVENT,
      prompt: "line1\n\nline2\n",
    };
    expect(extractContent(event, "user-prompt-submit")).toBe(
      "line1\n\nline2\n",
    );
  });
});

// =============================================================================
// metaTypeForEvent
// =============================================================================

describe("metaTypeForEvent", () => {
  test("maps user-prompt-submit to user_prompt", () => {
    expect(metaTypeForEvent("user-prompt-submit")).toBe("user_prompt");
  });

  test("maps stop to agent_response", () => {
    expect(metaTypeForEvent("stop")).toBe("agent_response");
  });
});

// =============================================================================
// deriveProject
// =============================================================================

describe("deriveProject", () => {
  test("falls back to cwd basename when git is unavailable", () => {
    // /tmp/__nonexistent-dir-for-test__ has no git remote
    const project = deriveProject("/tmp/myproject");
    // Can't assert exact value — may hit a git repo if /tmp is one.
    // But the result should be a lowercase, sanitized single label.
    expect(project).toMatch(/^[a-z0-9_]+$/);
  });

  test("handles empty cwd with 'unknown' fallback", () => {
    const project = deriveProject("");
    expect(project).toMatch(/^[a-z0-9_]+$/);
  });

  test("sanitizes special characters in basename", () => {
    const project = deriveProject("/tmp/my-proj.foo");
    // Result should only contain letters/digits/underscores
    expect(project).toMatch(/^[a-z0-9_]+$/);
  });
});

// =============================================================================
// buildMeta
// =============================================================================

describe("buildMeta", () => {
  test("builds metadata with required fields", () => {
    const event: HookEvent = { ...BASE_EVENT, prompt: "hi" };
    const meta = buildMeta(event, "user-prompt-submit", "myproject");

    expect(meta.type).toBe("user_prompt");
    expect(meta.session_id).toBe("sess-abc");
    expect(meta.cwd).toBe("/tmp/myproj");
    expect(meta.project).toBe("myproject");
    expect(meta.source).toBe("claude-code");
    expect(meta.me_version).toBeDefined();
    expect(typeof meta.me_version).toBe("string");
  });

  test("uses agent_response type for stop event", () => {
    const event: HookEvent = {
      ...BASE_EVENT,
      last_assistant_message: "done",
    };
    const meta = buildMeta(event, "stop", "proj");
    expect(meta.type).toBe("agent_response");
  });
});

// =============================================================================
// captureHookEvent
// =============================================================================

/** Build a mock EngineClient that records the last memory.create call. */
function mockClient(): {
  client: EngineClient;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    memory: {
      create: async (params: Record<string, unknown>) => {
        calls.push(params);
        return { id: "01960000-0000-7000-8000-000000000000" };
      },
    },
  } as unknown as EngineClient;
  return { client, calls };
}

describe("captureHookEvent", () => {
  test("skips empty content with no API call", async () => {
    const { client, calls } = mockClient();
    const event: HookEvent = { ...BASE_EVENT, prompt: "  " };

    const result = await captureHookEvent(event, "user-prompt-submit", CONFIG, {
      client,
    });

    expect(result.status).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  test("captures user prompt with correct tree + meta", async () => {
    const { client, calls } = mockClient();
    const event: HookEvent = { ...BASE_EVENT, prompt: "hello" };
    const now = new Date("2026-04-23T10:00:00Z");

    const result = await captureHookEvent(event, "user-prompt-submit", CONFIG, {
      client,
      now: () => now,
    });

    expect(result.status).toBe("captured");
    expect(result.memoryId).toBe("01960000-0000-7000-8000-000000000000");
    expect(calls).toHaveLength(1);
    const [call] = calls as [Record<string, unknown>];
    expect(call.content).toBe("hello");
    expect(call.tree).toBe("claude_code.sessions");
    expect(call.temporal).toEqual({ start: "2026-04-23T10:00:00.000Z" });
    const meta = call.meta as Record<string, string>;
    expect(meta.type).toBe("user_prompt");
    expect(meta.session_id).toBe("sess-abc");
    expect(meta.source).toBe("claude-code");
  });

  test("captures stop event with agent_response type", async () => {
    const { client, calls } = mockClient();
    const event: HookEvent = {
      ...BASE_EVENT,
      last_assistant_message: "goodbye",
    };

    const result = await captureHookEvent(event, "stop", CONFIG, { client });

    expect(result.status).toBe("captured");
    expect(calls).toHaveLength(1);
    const [call] = calls as [Record<string, unknown>];
    expect(call.content).toBe("goodbye");
    const meta = call.meta as Record<string, string>;
    expect(meta.type).toBe("agent_response");
  });

  test("uses custom tree_prefix from config", async () => {
    const { client, calls } = mockClient();
    const event: HookEvent = { ...BASE_EVENT, prompt: "x" };
    const cfg: PluginConfig = {
      ...CONFIG,
      tree_prefix: "my.custom.prefix",
    };

    await captureHookEvent(event, "user-prompt-submit", cfg, { client });

    const [call] = calls as [Record<string, unknown>];
    expect(call.tree).toBe("my.custom.prefix");
  });
});
