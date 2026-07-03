/**
 * Unit tests for Claude Code hook config resolution.
 *
 * Capture itself is the import path (importTranscriptFile, tested in
 * packages/cli/importers). This file covers resolveHookConfigFromEnv —
 * bearer/space/server/tree-root/content-mode resolution + session fallback —
 * and resolveCaptureEnabled, the inert-by-default capture gate.
 */
import { describe, expect, test } from "bun:test";
import {
  type HookConfig,
  resolveCaptureEnabled,
  resolveHookConfigFromEnv,
} from "./capture.ts";

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
      CLAUDE_PLUGIN_OPTION_CONTENT_MODE: "full_transcript",
    });
    expect(cfg).toEqual({
      apiKey: "me.lookupid12345678.secret",
      space: "eng123def456",
      server: "https://api.example.com",
      treeRoot: "~/projects",
      fullTranscript: true,
    } satisfies HookConfig);
  });

  test("defaults: server, PRIVATE tree root, content mode (default = not full)", () => {
    const cfg = resolveHookConfigFromEnv({
      CLAUDE_PLUGIN_OPTION_API_KEY: "me.lookupid12345678.secret",
      CLAUDE_PLUGIN_OPTION_SPACE: "eng123def456",
    });
    expect(cfg).toEqual({
      apiKey: "me.lookupid12345678.secret",
      space: "eng123def456",
      server: "https://api.memory.build",
      treeRoot: "~/projects",
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
      { loggedIn: true, server: "https://api.example.com" },
    );
    // Session path: no static api key — the bearer is resolved at send time.
    expect(cfg).not.toBeNull();
    expect(cfg?.apiKey).toBeUndefined();
    expect(cfg?.server).toBe("https://api.example.com");
  });

  test("treats an unsubstituted ${...} placeholder as blank (uses session)", () => {
    const cfg = resolveHookConfigFromEnv(
      {
        CLAUDE_PLUGIN_OPTION_API_KEY: "${user_config.api_key}",
        CLAUDE_PLUGIN_OPTION_SPACE: "eng123def456",
      },
      { loggedIn: true },
    );
    expect(cfg).not.toBeNull();
    expect(cfg?.apiKey).toBeUndefined();
  });

  test("uses the active space fallback when plugin space is unset", () => {
    const cfg = resolveHookConfigFromEnv(
      {},
      { loggedIn: true, activeSpace: "act123def456" },
    );
    expect(cfg?.space).toBe("act123def456");
  });

  test("plugin api_key takes precedence over the session", () => {
    const cfg = resolveHookConfigFromEnv(
      {
        CLAUDE_PLUGIN_OPTION_API_KEY: "me.lookupid12345678.secret",
        CLAUDE_PLUGIN_OPTION_SPACE: "eng123def456",
      },
      { loggedIn: true },
    );
    expect(cfg?.apiKey).toBe("me.lookupid12345678.secret");
  });

  test("a machine-wide tree_root (creds.treeRoot) replaces the ~/projects parent", () => {
    const cfg = resolveHookConfigFromEnv(
      {},
      { loggedIn: true, activeSpace: "act123def456", treeRoot: "~/work" },
    );
    expect(cfg?.treeRoot).toBe("~/work");
    // The .me tree still wins as the full project node when present.
    const withTree = resolveHookConfigFromEnv(
      {},
      { loggedIn: true, activeSpace: "act123def456", treeRoot: "~/work" },
      { tree: "share.projects.foo" },
    );
    expect(withTree?.tree).toBe("share.projects.foo");
    expect(withTree?.treeRoot).toBe("~/work");
  });

  test("a .me project tree sets tree (no-slug), keeping the default parent", () => {
    const cfg = resolveHookConfigFromEnv(
      {},
      { loggedIn: true, activeSpace: "act123def456" },
      { tree: "share.projects.foo" },
    );
    expect(cfg?.tree).toBe("share.projects.foo");
    expect(cfg?.treeRoot).toBe("~/projects");
  });

  test("a stale plugin tree_root env is IGNORED — the .me tree still routes", () => {
    // The `tree_root` userConfig is retired: a leftover value from an old
    // install must not override committed project config (or force the old
    // shared layout back on).
    const cfg = resolveHookConfigFromEnv(
      {
        CLAUDE_PLUGIN_OPTION_SPACE: "eng123def456",
        CLAUDE_PLUGIN_OPTION_TREE_ROOT: "share.work",
      },
      { loggedIn: true },
      { tree: "share.projects.foo" },
    );
    expect(cfg?.treeRoot).toBe("~/projects");
    expect(cfg?.tree).toBe("share.projects.foo");
  });

  test("a .me project server/space fill in when plugin + session lack them", () => {
    const cfg = resolveHookConfigFromEnv(
      {},
      { loggedIn: true },
      { server: "https://project.example", space: "proj123space6" },
    );
    expect(cfg?.server).toBe("https://project.example");
    expect(cfg?.space).toBe("proj123space6");
  });

  test("a plugin-pinned space wins over the .me project space", () => {
    const cfg = resolveHookConfigFromEnv(
      { CLAUDE_PLUGIN_OPTION_SPACE: "plugin12space" },
      { loggedIn: true },
      { space: "proj123space6" },
    );
    expect(cfg?.space).toBe("plugin12space");
  });
});

describe("resolveCaptureEnabled", () => {
  test("off by default — the hook ships inert", () => {
    expect(resolveCaptureEnabled({}, {})).toBe(false);
    expect(resolveCaptureEnabled({ loggedIn: true }, {})).toBe(false);
  });

  test("the machine-wide setting turns it on", () => {
    expect(resolveCaptureEnabled({ captureEnabled: true }, {})).toBe(true);
    expect(resolveCaptureEnabled({ captureEnabled: false }, {})).toBe(false);
  });

  test("project capture: true wins over a global off (team repo opt-in)", () => {
    expect(
      resolveCaptureEnabled({ captureEnabled: false }, { capture: true }),
    ).toBe(true);
    expect(resolveCaptureEnabled({}, { capture: true })).toBe(true);
  });

  test("project capture: false wins over a global on (per-project opt-out)", () => {
    expect(
      resolveCaptureEnabled({ captureEnabled: true }, { capture: false }),
    ).toBe(false);
  });

  test("credential-agnostic: an api key never turns capture on by itself", () => {
    // A key answers WHO captures write as, not WHETHER they happen — a
    // headless box opts in via the same capture flags as everyone else.
    expect(
      resolveCaptureEnabled(
        { apiKey: "me.lookupid12345678.secret", captureEnabled: false },
        {},
      ),
    ).toBe(false);
    expect(resolveCaptureEnabled({ apiKey: "me.k" }, {})).toBe(false);
    // …and the flags still work as usual with a key present.
    expect(
      resolveCaptureEnabled({ apiKey: "me.k", captureEnabled: true }, {}),
    ).toBe(true);
    expect(resolveCaptureEnabled({ apiKey: "me.k" }, { capture: true })).toBe(
      true,
    );
  });
});
