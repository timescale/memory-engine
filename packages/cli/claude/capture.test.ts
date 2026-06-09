/**
 * Unit tests for Claude Code hook capture logic.
 */
import { describe, expect, test } from "bun:test";
import type { MemoryClient } from "@memory.build/client";
import {
  buildMeta,
  captureHookEvent,
  extractContent,
  type HookConfig,
  type HookEvent,
  metaTypeForEvent,
  resolveHookConfigFromEnv,
} from "./capture.ts";

const BASE_EVENT = {
  session_id: "sess-abc",
  cwd: "/tmp/myproj",
  hook_event_name: "UserPromptSubmit",
  transcript_path: "/tmp/transcript.jsonl",
};

const CONFIG: HookConfig = {
  server: "https://api.example.com",
  token: "me.lookupid12345678.secret",
  space: "eng123",
  treeRoot: "share.projects",
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

// (Project-slug derivation lives in importers/slug.ts — resolveProjectSlug —
// and is covered by slug.test.ts; the hook just consumes it.)

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

/** Build a mock MemoryClient that records the last memory.create call. */
function mockClient(): {
  client: MemoryClient;
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
  } as unknown as MemoryClient;
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
    expect(call.temporal).toEqual({ start: "2026-04-23T10:00:00.000Z" });
    const meta = call.meta as Record<string, string>;
    // Nested as <treeRoot>.<project>.agent_sessions (project derived from cwd).
    expect(call.tree).toBe(`share.projects.${meta.project}.agent_sessions`);
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

  test("nests under a custom treeRoot from config", async () => {
    const { client, calls } = mockClient();
    const event: HookEvent = { ...BASE_EVENT, prompt: "x" };
    const cfg: HookConfig = {
      ...CONFIG,
      treeRoot: "~.work",
    };

    await captureHookEvent(event, "user-prompt-submit", cfg, { client });

    const [call] = calls as [Record<string, unknown>];
    const meta = call.meta as Record<string, string>;
    expect(call.tree).toBe(`~.work.${meta.project}.agent_sessions`);
  });
});

// =============================================================================
// resolveHookConfigFromEnv
// =============================================================================

describe("resolveHookConfigFromEnv", () => {
  test("returns null when no api_key and no session fallback", () => {
    const cfg = resolveHookConfigFromEnv({});
    expect(cfg).toBeNull();
  });

  test("returns null when space is missing (keys are global)", () => {
    const cfg = resolveHookConfigFromEnv({
      CLAUDE_PLUGIN_OPTION_API_KEY: "me.lookupid12345678.secret",
    });
    expect(cfg).toBeNull();
  });

  test("returns config when api_key and space are present", () => {
    const cfg = resolveHookConfigFromEnv({
      CLAUDE_PLUGIN_OPTION_API_KEY: "me.lookupid12345678.secret",
      CLAUDE_PLUGIN_OPTION_SPACE: "eng123def456",
      CLAUDE_PLUGIN_OPTION_SERVER: "https://api.example.com",
      CLAUDE_PLUGIN_OPTION_TREE_ROOT: "my.root",
    });
    expect(cfg).toEqual({
      token: "me.lookupid12345678.secret",
      space: "eng123def456",
      server: "https://api.example.com",
      treeRoot: "my.root",
    });
  });

  test("falls back to default server and tree_root", () => {
    const cfg = resolveHookConfigFromEnv({
      CLAUDE_PLUGIN_OPTION_API_KEY: "me.lookupid12345678.secret",
      CLAUDE_PLUGIN_OPTION_SPACE: "eng123def456",
    });
    expect(cfg).toEqual({
      token: "me.lookupid12345678.secret",
      space: "eng123def456",
      server: "https://api.memory.build",
      treeRoot: "share.projects",
    });
  });

  test("falls back to the login session when api_key is blank", () => {
    const cfg = resolveHookConfigFromEnv(
      { CLAUDE_PLUGIN_OPTION_SPACE: "eng123def456" },
      { sessionToken: "sess-token", server: "https://api.example.com" },
    );
    expect(cfg).toEqual({
      token: "sess-token",
      space: "eng123def456",
      server: "https://api.example.com",
      treeRoot: "share.projects",
    });
  });

  test("treats an unsubstituted ${...} placeholder as blank (uses session)", () => {
    const cfg = resolveHookConfigFromEnv(
      {
        CLAUDE_PLUGIN_OPTION_API_KEY: "${user_config.api_key}",
        CLAUDE_PLUGIN_OPTION_SPACE: "eng123def456",
      },
      { sessionToken: "sess-token" },
    );
    expect(cfg?.token).toBe("sess-token");
  });

  test("uses the active space fallback when plugin space is unset", () => {
    const cfg = resolveHookConfigFromEnv(
      {},
      { sessionToken: "sess-token", activeSpace: "act123def456" },
    );
    expect(cfg?.space).toBe("act123def456");
  });

  test("plugin api_key takes precedence over the session", () => {
    const cfg = resolveHookConfigFromEnv(
      {
        CLAUDE_PLUGIN_OPTION_API_KEY: "me.lookupid12345678.secret",
        CLAUDE_PLUGIN_OPTION_SPACE: "eng123def456",
      },
      { sessionToken: "sess-token" },
    );
    expect(cfg?.token).toBe("me.lookupid12345678.secret");
  });

  test("treats empty string as missing (falls back to default)", () => {
    const cfg = resolveHookConfigFromEnv({
      CLAUDE_PLUGIN_OPTION_API_KEY: "me.lookupid12345678.secret",
      CLAUDE_PLUGIN_OPTION_SPACE: "eng123def456",
      CLAUDE_PLUGIN_OPTION_SERVER: "",
      CLAUDE_PLUGIN_OPTION_TREE_ROOT: "",
    });
    expect(cfg?.server).toBe("https://api.memory.build");
    expect(cfg?.treeRoot).toBe("share.projects");
  });
});
