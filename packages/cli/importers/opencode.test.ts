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
const NOISE_FIXTURE_DIR = join(
  import.meta.dir,
  "__fixtures__",
  "opencode-noise",
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

  test("emits one message per msg_<id>, ordered by message creation time", async () => {
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    if (!s) return;
    expect(s.messages.map((m) => m.messageId)).toEqual(["msg_1", "msg_2"]);
    expect(s.messages[0]?.role).toBe("user");
    expect(s.messages[1]?.role).toBe("assistant");
  });

  test("user message carries a single text block", async () => {
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    if (!s) return;
    const user = s.messages[0];
    expect(user?.blocks).toHaveLength(1);
    expect(user?.blocks[0]?.kind).toBe("text");
    expect(user?.blocks[0]?.text).toContain("bootstrap a Bun project");
  });

  test("assistant message carries reasoning + text + tool_use + tool_result blocks", async () => {
    const { sessions } = await collect(baseOptions());
    const s = sessions[0];
    if (!s) return;
    const asst = s.messages[1];
    const kinds = asst?.blocks.map((b) => b.kind) ?? [];
    expect(kinds).toEqual(["thinking", "text", "tool_use", "tool_result"]);
    const toolUse = asst?.blocks.find((b) => b.kind === "tool_use");
    expect(toolUse?.toolName).toBe("bash");
    expect(toolUse?.text).toContain("bun init -y");
  });

  test("drops synthetic user text wrapper messages", async () => {
    const { sessions } = await collect(
      baseOptions({ source: NOISE_FIXTURE_DIR }),
    );
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    if (!s) return;

    expect(s.messages.map((m) => m.messageId)).toEqual([
      "msg_real",
      "msg_asst",
    ]);
    expect(s.messages[0]?.blocks[0]?.text).toBe(
      "Explore DM image handling code.",
    );
  });
});
