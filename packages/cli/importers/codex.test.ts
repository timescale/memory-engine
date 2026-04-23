/**
 * Codex importer fixture tests.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { codexImporter } from "./codex.ts";
import type {
  ImportedSession,
  ImporterOptions,
  ImporterStats,
} from "./types.ts";

const FIXTURE_DIR = join(import.meta.dir, "__fixtures__", "codex");

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
  for await (const s of codexImporter.discoverSessions(options, stats)) {
    sessions.push(s);
  }
  return { sessions, stats };
}

describe("codex importer", () => {
  test("parses session_meta and yields one normalized session", async () => {
    const { sessions } = await collect(baseOptions());
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    if (!s) return;
    expect(s.sessionId).toBe("01234567-89ab-71de-9abc-def012345678");
    expect(s.cwd).toBe("/Users/test/codex-project");
    expect(s.toolVersion).toBe("0.107.0");
    expect(s.provider).toBe("openai");
    expect(s.gitBranch).toBe("main");
    expect(s.gitCommit).toBe("aabbccddeeff00112233");
    expect(s.gitRepo).toBe("git@github.com:test/codex-project.git");
  });

  test("extracts user/assistant/reasoning/function_call turns", async () => {
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    if (!s) return;
    const userTexts = s.turns
      .filter((t) => t.role === "user")
      .map((t) => t.text);
    expect(userTexts).toContain("Explain the codex-core crate.");
    expect(userTexts).toContain("What about codex-cli?");
    expect(s.turns.some((t) => t.role === "reasoning")).toBe(true);
    expect(s.turns.some((t) => t.role === "tool_call")).toBe(true);
    expect(s.turns.some((t) => t.role === "tool_result")).toBe(true);
    expect(s.messageCounts.user).toBe(2);
    expect(s.messageCounts.assistant).toBe(2);
    expect(s.messageCounts.tool_calls).toBe(1);
  });

  test("harvests token counts from event_msg", async () => {
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    if (!s?.tokens) return;
    expect(s.tokens.input).toBe(1000);
    expect(s.tokens.output).toBe(50);
    expect(s.tokens.reasoning).toBe(20);
  });
});
