/**
 * Unit tests for Claude Code hook config resolution.
 *
 * Capture itself is the import path (importTranscriptFile, tested in
 * packages/cli/importers). This file only covers resolveHookConfigFromEnv —
 * bearer/space/server/tree-root/content-mode resolution + session fallback.
 */
import { describe, expect, test } from "bun:test";
import { type HookConfig, resolveHookConfigFromEnv } from "./capture.ts";

describe("resolveHookConfigFromEnv", () => {
  test("returns null when no api_key and no session fallback", () => {
    expect(resolveHookConfigFromEnv({})).toBeNull();
  });

  test("returns null when space is missing", () => {
    expect(
      resolveHookConfigFromEnv({
        CLAUDE_PLUGIN_OPTION_API_KEY: "me.lookupid12345678.secret",
      }),
    ).toBeNull();
  });

  test("resolves full config from plugin env", () => {
    const cfg = resolveHookConfigFromEnv({
      CLAUDE_PLUGIN_OPTION_API_KEY: "me.lookupid12345678.secret",
      CLAUDE_PLUGIN_OPTION_SPACE: "eng123def456",
      CLAUDE_PLUGIN_OPTION_SERVER: "https://api.example.com",
      CLAUDE_PLUGIN_OPTION_TREE_ROOT: "share.work",
      CLAUDE_PLUGIN_OPTION_CONTENT_MODE: "full_transcript",
    });
    expect(cfg).toEqual({
      token: "me.lookupid12345678.secret",
      space: "eng123def456",
      server: "https://api.example.com",
      treeRoot: "share.work",
      fullTranscript: true,
    } satisfies HookConfig);
  });

  test("defaults: server, tree root, content mode (default = not full)", () => {
    const cfg = resolveHookConfigFromEnv({
      CLAUDE_PLUGIN_OPTION_API_KEY: "me.lookupid12345678.secret",
      CLAUDE_PLUGIN_OPTION_SPACE: "eng123def456",
    });
    expect(cfg).toEqual({
      token: "me.lookupid12345678.secret",
      space: "eng123def456",
      server: "https://api.memory.build",
      treeRoot: "share.projects",
      fullTranscript: false,
    } satisfies HookConfig);
  });

  test("content_mode=default → fullTranscript false", () => {
    const cfg = resolveHookConfigFromEnv({
      CLAUDE_PLUGIN_OPTION_API_KEY: "k",
      CLAUDE_PLUGIN_OPTION_SPACE: "s",
      CLAUDE_PLUGIN_OPTION_CONTENT_MODE: "default",
    });
    expect(cfg?.fullTranscript).toBe(false);
  });

  test("falls back to the login session when api_key is blank", () => {
    const cfg = resolveHookConfigFromEnv(
      { CLAUDE_PLUGIN_OPTION_SPACE: "eng123def456" },
      { sessionToken: "sess-token", server: "https://api.example.com" },
    );
    expect(cfg?.token).toBe("sess-token");
    expect(cfg?.server).toBe("https://api.example.com");
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
});
