/**
 * Unit tests for importTranscriptFile — the live-capture (Claude hook) path.
 *
 * Uses a fake importer (parseFile returns a synthetic session) + an in-memory
 * mock client that round-trips meta through the real buildMeta, so the
 * watermark / incremental-delta / reconcile-fallback logic is exercised without
 * a database.
 */
import { describe, expect, test } from "bun:test";
import type { MemoryClient } from "../client.ts";
import {
  type Importer,
  importTranscriptFile,
  type WriteOptions,
} from "./index.ts";
import type { ConversationMessage, ImportedSession } from "./types.ts";

const WRITE: WriteOptions = {
  treeRoot: "share.projects",
  sessionsNodeName: "agent_sessions",
  fullTranscript: false,
  dryRun: false,
  verbose: false,
};

/** A mock engine backed by an in-memory id→meta store, mimicking the server. */
function mockEngine() {
  const store = new Map<
    string,
    { id: string; meta: Record<string, unknown> }
  >();
  const client = {
    memory: {
      // Filter by source_session_id, order by id desc (server default), slice to limit.
      search: async (p: { meta?: Record<string, unknown>; limit?: number }) => {
        const sid = p.meta?.source_session_id;
        const all = [...store.values()]
          .filter((m) => m.meta.source_session_id === sid)
          .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        const limit = p.limit ?? 10;
        return { results: all.slice(0, limit), total: all.length, limit };
      },
      batchCreate: async (p: {
        memories: Array<{ id: string; meta: Record<string, unknown> }>;
      }) => {
        const ids: string[] = [];
        for (const m of p.memories) {
          if (store.has(m.id)) throw new Error(`duplicate id ${m.id}`);
          store.set(m.id, { id: m.id, meta: m.meta });
          ids.push(m.id);
        }
        return { ids };
      },
    },
  } as unknown as MemoryClient;
  return { client, store };
}

/** An importer whose parseFile returns a fixed session (or null). */
function importerFor(session: ImportedSession | null): Importer {
  return {
    tool: "claude",
    defaultSource: "",
    // biome-ignore lint/correctness/useYield: empty stub generator
    discoverSessions: async function* () {},
    parseFile: async () => session,
  };
}

/** Build a session whose messages have strictly-increasing timestamps. */
function session(messageIds: string[]): ImportedSession {
  const messages: ConversationMessage[] = messageIds.map((id, i) => ({
    messageId: id,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    role: i % 2 === 0 ? "user" : "assistant",
    blocks: [{ kind: "text", text: `message ${id}` }],
  }));
  return {
    tool: "claude",
    sessionId: "sess-1",
    cwd: "/tmp/nonexistent-import-transcript-test/myproj",
    sourceFile: "/tmp/transcript.jsonl",
    startedAt: messages[0]?.timestamp ?? "2026-01-01T00:00:00.000Z",
    endedAt: messages.at(-1)?.timestamp ?? "2026-01-01T00:00:00.000Z",
    sourceModifiedAt: "2026-01-01T00:00:00.000Z",
    messages,
  };
}

describe("importTranscriptFile", () => {
  test("returns null when the file has no session", async () => {
    const { client, store } = mockEngine();
    expect(
      await importTranscriptFile(client, importerFor(null), "/x.jsonl", WRITE),
    ).toBeNull();
    expect(store.size).toBe(0);
  });

  test("first import writes every message (reconcile path)", async () => {
    const { client, store } = mockEngine();
    const out = await importTranscriptFile(
      client,
      importerFor(session(["a", "b", "c"])),
      "/x.jsonl",
      WRITE,
    );
    expect(out?.inserted).toBe(3);
    expect(store.size).toBe(3);
  });

  test("re-importing the same transcript is a no-op (watermark fast path)", async () => {
    const { client, store } = mockEngine();
    const imp = () =>
      importTranscriptFile(
        client,
        importerFor(session(["a", "b", "c"])),
        "/x.jsonl",
        WRITE,
      );
    await imp();
    const again = await imp();
    expect(again?.inserted).toBe(0);
    expect(store.size).toBe(3);
  });

  test("only messages new since the watermark are written", async () => {
    const { client, store } = mockEngine();
    await importTranscriptFile(
      client,
      importerFor(session(["a", "b", "c"])),
      "/x.jsonl",
      WRITE,
    );
    const out = await importTranscriptFile(
      client,
      importerFor(session(["a", "b", "c", "d"])),
      "/x.jsonl",
      WRITE,
    );
    expect(out?.inserted).toBe(1); // just "d"
    expect(store.size).toBe(4);
  });
});
