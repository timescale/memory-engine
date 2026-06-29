/**
 * Tests for the Granola importer orchestration: pre-filtering (deleted,
 * invalid, since/until), the empty-meeting skip, per-meeting panel/transcript
 * fetching, and the batchCreate submission path — all against a fake source +
 * in-memory engine (no network, no DB).
 */
import { describe, expect, test } from "bun:test";
import type { MemoryClient } from "../../client.ts";
import type {
  GranolaDocument,
  GranolaPanel,
  GranolaTranscriptSegment,
} from "./client.ts";
import {
  type GranolaImportOptions,
  type GranolaSource,
  runGranolaImport,
} from "./index.ts";

const BASE_OPTS: Omit<GranolaImportOptions, "refreshToken"> = {
  treeRoot: "~.granola",
  skipInvalid: true,
  includeTranscript: true,
  dryRun: false,
};

function opts(over: Partial<GranolaImportOptions> = {}): GranolaImportOptions {
  return { refreshToken: "r", ...BASE_OPTS, ...over };
}

/** A fake Granola API source backed by in-memory docs/panels/transcripts. */
function fakeSource(opts: {
  docs: GranolaDocument[];
  panels?: Record<string, GranolaPanel[]>;
  transcripts?: Record<string, GranolaTranscriptSegment[]>;
}): GranolaSource & { panelCalls: string[]; transcriptCalls: string[] } {
  const panelCalls: string[] = [];
  const transcriptCalls: string[] = [];
  return {
    panelCalls,
    transcriptCalls,
    async *listDocuments() {
      for (const d of opts.docs) yield d;
    },
    async getPanels(id) {
      panelCalls.push(id);
      return opts.panels?.[id] ?? [];
    },
    async getTranscript(id) {
      transcriptCalls.push(id);
      return opts.transcripts?.[id] ?? [];
    },
  };
}

/** An in-memory engine that records batchCreate inputs and reports inserts. */
function mockEngine() {
  const submitted: Array<{ tree: string; name?: string | null }> = [];
  const client = {
    memory: {
      batchCreate: async (p: {
        memories: Array<{ tree: string; name?: string | null }>;
      }) => {
        submitted.push(...p.memories);
        return {
          results: p.memories.map((m) => ({
            id: "00000000-0000-7000-8000-000000000000",
            status: "inserted" as const,
            name: m.name ?? null,
          })),
        };
      },
    },
  } as unknown as MemoryClient;
  return { client, submitted };
}

const NOTES_DOC: GranolaDocument = {
  id: "doc-notes",
  title: "Has Notes",
  created_at: "2026-01-02T00:00:00.000Z",
  notes_markdown: "# real notes",
  valid_meeting: true,
};

describe("runGranolaImport pre-filters", () => {
  test("skips deleted, invalid, and out-of-window meetings", async () => {
    const { client, submitted } = mockEngine();
    const source = fakeSource({
      docs: [
        NOTES_DOC,
        { id: "del", title: "Deleted", deleted_at: "2026-01-01T00:00:00Z" },
        { id: "inv", title: "Invalid", valid_meeting: false },
        {
          id: "old",
          title: "Old",
          created_at: "2020-01-01T00:00:00.000Z",
          notes_markdown: "old",
        },
      ],
    });
    const result = await runGranolaImport(
      client,
      opts({ since: "2026-01-01T00:00:00Z" }),
      undefined,
      source,
    );
    expect(result.meetingsSeen).toBe(4);
    expect(result.inserted).toBe(1);
    expect(result.skipReasons.deleted).toBe(1);
    expect(result.skipReasons.invalid_meeting).toBe(1);
    expect(result.skipReasons.since_filter).toBe(1);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.name).toBe("doc-notes");
    expect(submitted[0]?.tree).toBe("~.granola");
  });

  test("--include-invalid keeps non-meeting notes", async () => {
    const { client, submitted } = mockEngine();
    const source = fakeSource({
      docs: [
        {
          id: "inv",
          title: "Invalid",
          notes_markdown: "x",
          valid_meeting: false,
        },
      ],
    });
    const result = await runGranolaImport(
      client,
      opts({ skipInvalid: false }),
      undefined,
      source,
    );
    expect(result.inserted).toBe(1);
    expect(submitted).toHaveLength(1);
  });
});

describe("runGranolaImport content fetching", () => {
  test("fetches panels only when the doc lacks notes_markdown", async () => {
    const { client } = mockEngine();
    const source = fakeSource({
      docs: [
        NOTES_DOC,
        {
          id: "no-notes",
          title: "Needs Panel",
          created_at: "2026-01-03T00:00:00Z",
        },
      ],
      panels: {
        "no-notes": [{ id: "p", original_content: "<p>panel notes</p>" }],
      },
    });
    await runGranolaImport(client, opts(), undefined, source);
    // doc-notes already has notes_markdown → no panel call; no-notes → one call.
    expect(source.panelCalls).toEqual(["no-notes"]);
  });

  test("skips a meeting with no notes and no transcript", async () => {
    const { client, submitted } = mockEngine();
    const source = fakeSource({
      docs: [
        { id: "stub", title: "Empty", created_at: "2026-01-04T00:00:00Z" },
      ],
    });
    const result = await runGranolaImport(client, opts(), undefined, source);
    expect(result.skipReasons.empty).toBe(1);
    expect(result.inserted).toBe(0);
    expect(submitted).toHaveLength(0);
  });

  test("--no-transcript skips transcript fetches", async () => {
    const { client } = mockEngine();
    const source = fakeSource({
      docs: [NOTES_DOC],
      transcripts: { "doc-notes": [{ text: "hi", source: "microphone" }] },
    });
    await runGranolaImport(
      client,
      opts({ includeTranscript: false }),
      undefined,
      source,
    );
    expect(source.transcriptCalls).toHaveLength(0);
  });

  test("includes a meeting that has only a transcript", async () => {
    const { client, submitted } = mockEngine();
    const source = fakeSource({
      docs: [
        { id: "t-only", title: "Talk", created_at: "2026-01-05T00:00:00Z" },
      ],
      transcripts: {
        "t-only": [
          { text: "Hello", source: "microphone" },
          { text: "Hi", source: "system" },
        ],
      },
    });
    const result = await runGranolaImport(client, opts(), undefined, source);
    expect(result.inserted).toBe(1);
    expect(submitted).toHaveLength(1);
  });
});

describe("runGranolaImport dry run", () => {
  test("reports planned inserts without submitting", async () => {
    const { client, submitted } = mockEngine();
    const source = fakeSource({ docs: [NOTES_DOC] });
    const result = await runGranolaImport(
      client,
      opts({ dryRun: true }),
      undefined,
      source,
    );
    expect(result.inserted).toBe(1);
    expect(submitted).toHaveLength(0);
  });
});
