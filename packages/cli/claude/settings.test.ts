/**
 * Tests for Claude `settings.json` hook/env shaping (`claude/settings.ts`).
 */
import { describe, expect, test } from "bun:test";
import {
  claudeSettingsHasCapture,
  ENV_KEY,
  hookCommand,
  removeClaudeSettings,
  upsertClaudeSettings,
} from "./settings.ts";

describe("hookCommand", () => {
  test("user scope: plain me + --scope user", () => {
    expect(hookCommand("user", "Stop")).toBe(
      "me claude hook --scope user --event stop",
    );
    expect(hookCommand("user", "SessionEnd")).toBe(
      "me claude hook --scope user --event session-end",
    );
  });

  test("project scope: --as-agent .me + --scope project", () => {
    expect(hookCommand("project", "Stop")).toBe(
      "me --as-agent .me claude hook --scope project --event stop",
    );
  });
});

describe("upsertClaudeSettings", () => {
  test("adds Stop + SessionEnd capture hooks", () => {
    const s = upsertClaudeSettings({}, { scope: "user" });
    expect(claudeSettingsHasCapture(s)).toBe(true);
    const hooks = s.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toHaveLength(1);
    expect(hooks.SessionEnd).toHaveLength(1);
  });

  test("project scope injects env.ME_AS_AGENT; user scope does not", () => {
    const project = upsertClaudeSettings({}, { scope: "project" });
    expect((project.env as Record<string, string>)[ENV_KEY]).toBe(".me");
    const user = upsertClaudeSettings({}, { scope: "user" });
    expect(user.env).toBeUndefined();
  });

  test("preserves foreign hooks and env; idempotent re-upsert", () => {
    const existing = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "other-tool run" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ command: "guard" }] }],
      },
      env: { FOO: "1" },
    };
    const once = upsertClaudeSettings(existing, { scope: "project" });
    const twice = upsertClaudeSettings(once, { scope: "project" });
    expect(twice).toEqual(once);

    const hooks = twice.hooks as Record<string, unknown[]>;
    // foreign Stop hook kept + our one added
    expect(hooks.Stop).toHaveLength(2);
    expect(hooks.PreToolUse).toHaveLength(1);
    expect((twice.env as Record<string, string>).FOO).toBe("1");
    expect((twice.env as Record<string, string>)[ENV_KEY]).toBe(".me");
  });

  test("re-upsert replaces a stale command in place (no duplicate)", () => {
    const v1 = upsertClaudeSettings({}, { scope: "user" });
    const v2 = upsertClaudeSettings(v1, { scope: "project" });
    const stop = (
      v2.hooks as Record<string, { hooks: { command: string }[] }[]>
    ).Stop;
    expect(stop).toHaveLength(1);
    expect(stop?.[0]?.hooks[0]?.command).toContain("--as-agent .me");
  });
});

describe("removeClaudeSettings", () => {
  test("removes our hooks + env, keeps foreign entries", () => {
    const installed = upsertClaudeSettings(
      {
        hooks: { Stop: [{ hooks: [{ command: "other run" }] }] },
        env: { FOO: "1" },
      },
      { scope: "project" },
    );
    const removed = removeClaudeSettings(installed);
    expect(claudeSettingsHasCapture(removed)).toBe(false);
    const hooks = removed.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toHaveLength(1); // foreign kept
    expect(hooks.SessionEnd).toBeUndefined(); // ours-only event dropped
    expect((removed.env as Record<string, string>).FOO).toBe("1");
    expect((removed.env as Record<string, string>)[ENV_KEY]).toBeUndefined();
  });

  test("drops empty hooks/env objects entirely", () => {
    const installed = upsertClaudeSettings({}, { scope: "project" });
    const removed = removeClaudeSettings(installed);
    expect(removed.hooks).toBeUndefined();
    expect(removed.env).toBeUndefined();
  });

  test("keeps a foreign env var of the same key if not our value", () => {
    const s = { env: { ME_AS_AGENT: "custom-agent" } };
    expect(
      (removeClaudeSettings(s).env as Record<string, string>)[ENV_KEY],
    ).toBe("custom-agent");
  });
});
