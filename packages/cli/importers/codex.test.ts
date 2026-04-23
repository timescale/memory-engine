/**
 * Codex importer fixture tests.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { codexImporter } from "./codex.ts";
import type {
  ConversationMessage,
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

function userTextsOf(messages: ConversationMessage[]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) =>
      m.blocks.filter((b) => b.kind === "text").map((b) => b.text),
    );
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

  test("emits one message per response_item with native ids where available", async () => {
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    if (!s) return;
    const userTexts = userTextsOf(s.messages);
    expect(userTexts).toContain("Explain the codex-core crate.");
    expect(userTexts).toContain("What about codex-cli?");

    const byRole = Object.fromEntries(
      (
        ["user", "assistant", "reasoning", "tool_call", "tool_result"] as const
      ).map((r) => [r, s.messages.filter((m) => m.role === r).length]),
    );
    expect(byRole.user).toBe(2);
    expect(byRole.assistant).toBe(2);
    expect(byRole.reasoning).toBe(1);
    expect(byRole.tool_call).toBe(1);
    expect(byRole.tool_result).toBe(1);

    // Native message ids are used where the source provides them.
    const nativeIds = s.messages.map((m) => m.messageId);
    expect(nativeIds).toContain("m-1");
    expect(nativeIds).toContain("m-2");
    expect(nativeIds).toContain("m-3");
    expect(nativeIds).toContain("m-4");

    // tool_call / tool_result fall back to call_id when there's no native id.
    const toolCall = s.messages.find((m) => m.role === "tool_call");
    const toolResult = s.messages.find((m) => m.role === "tool_result");
    expect(toolCall?.messageId).toBe("c1");
    expect(toolResult?.messageId).toBe("c1");

    // Reasoning has no native id; we synthesize a stable fallback.
    const reasoning = s.messages.find((m) => m.role === "reasoning");
    expect(reasoning?.messageId).toMatch(/^syn:reasoning:/);
  });
});
