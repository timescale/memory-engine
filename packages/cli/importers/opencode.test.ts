/**
 * OpenCode importer fixture tests.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { opencodeImporter } from "./opencode.ts";
import type {
  ImportedSession,
  ImporterOptions,
  ImporterStats,
} from "./types.ts";

const FIXTURE_DIR = join(
  import.meta.dir,
  "__fixtures__",
  "opencode",
  "storage",
);

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
  for await (const s of opencodeImporter.discoverSessions(options, stats)) {
    sessions.push(s);
  }
  return { sessions, stats };
}

describe("opencode importer", () => {
  test("assembles session from split storage directories", async () => {
    const { sessions } = await collect(baseOptions());
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    if (!s) return;
    expect(s.sessionId).toBe("ses_test");
    expect(s.title).toBe("Bootstrap Bun project");
    expect(s.cwd).toBe("/Users/test/opencode-project");
    expect(s.model).toBe("gemini-3-pro-preview");
    expect(s.provider).toBe("google");
    expect(s.agentMode).toBe("plan");
  });

  test("orders turns by part start time across messages", async () => {
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    if (!s) return;
    // User prompt comes first (msg_1), assistant reasoning+text comes second.
    const textTurns = s.turns.filter(
      (t) => t.role === "user" || t.role === "assistant",
    );
    expect(textTurns[0]?.role).toBe("user");
    expect(textTurns[0]?.text).toContain("bootstrap a Bun project");
    expect(textTurns[1]?.role).toBe("assistant");
    expect(textTurns[1]?.text).toContain("bun init -y");
  });

  test("captures reasoning and tool parts when full transcript requested", async () => {
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    if (!s) return;
    expect(s.turns.some((t) => t.role === "reasoning")).toBe(true);
    expect(s.turns.some((t) => t.role === "tool_call")).toBe(true);
    expect(s.turns.some((t) => t.role === "tool_result")).toBe(true);
    expect(s.messageCounts.tool_calls).toBe(1);
    expect(s.messageCounts.user).toBe(1);
    expect(s.messageCounts.assistant).toBe(1);
  });

  test("sums cost and tokens across messages", async () => {
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    if (!s) return;
    expect(s.costUsd).toBeCloseTo(0.015);
    expect(s.tokens?.input).toBe(1000);
    expect(s.tokens?.output).toBe(100);
  });
});
