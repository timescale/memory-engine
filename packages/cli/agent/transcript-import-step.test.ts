/**
 * Tests for the per-harness transcript-import step factory. `run()` is a
 * thin 3-line delegation to `runAgentImport` (exercised by e2e); these
 * cover the actual logic — the session-presence probe and the
 * `available()` gate built on it.
 */
import { describe, expect, test } from "bun:test";
import type { ImportedSession } from "../importers/types.ts";
import {
  projectHasSessions,
  transcriptImportStep,
} from "./transcript-import-step.ts";

/** A fake importer yielding a fixed set of sessions, ignoring options. */
function fakeImporter(sessions: Partial<ImportedSession>[]) {
  return {
    tool: "claude" as const,
    defaultSource: "/fake",
    discoverSessions: async function* () {
      for (const s of sessions) yield s as ImportedSession;
    },
  };
}

describe("projectHasSessions", () => {
  test("false when the importer yields nothing", async () => {
    expect(await projectHasSessions(fakeImporter([]), "/repo")).toBe(false);
  });

  test("true on the first yielded session, without exhausting the rest", async () => {
    let yieldedCount = 0;
    const importer = {
      tool: "claude" as const,
      defaultSource: "/fake",
      discoverSessions: async function* () {
        yieldedCount++;
        yield {} as ImportedSession;
        yieldedCount++;
        yield {} as ImportedSession;
      },
    };
    expect(await projectHasSessions(importer, "/repo")).toBe(true);
    expect(yieldedCount).toBe(1);
  });
});

describe("transcriptImportStep", () => {
  test("hidden when the project has no sessions for this harness", async () => {
    const step = transcriptImportStep("codex", fakeImporter([]), "Codex");
    expect(
      await step.available?.({ globalOpts: {}, projectRoot: "/repo" }),
    ).toBe("hidden");
  });

  test("available when the project has at least one session", async () => {
    const step = transcriptImportStep(
      "codex",
      fakeImporter([{ sessionId: "s1" }]),
      "Codex",
    );
    expect(
      await step.available?.({ globalOpts: {}, projectRoot: "/repo" }),
    ).toBe("available");
  });

  test("ids and flags are namespaced per tool", () => {
    const step = transcriptImportStep("opencode", fakeImporter([]), "OpenCode");
    expect(step.id).toBe("transcript-import-opencode");
    expect(step.skipFlag).toBe("--skip-transcript-import-opencode");
    expect(step.optionKey).toBe("skipTranscriptImportOpencode");
    expect(step.group).toBe("OpenCode sessions");
  });
});
