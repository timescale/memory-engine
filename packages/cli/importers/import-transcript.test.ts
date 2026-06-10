/**
 * Unit tests for importTranscriptFile — the live-capture (Claude hook) path.
 *
 * Uses a fake importer (parseFile returns a synthetic session) + an in-memory
 * mock client that round-trips meta through the real buildMeta and simulates
 * the server's conditional upsert, so the watermark / incremental-delta /
 * version-bump re-render logic is exercised without a database.
 */
import { describe, expect, test } from "bun:test";
import type { MemoryClient } from "../client.ts";
import {
  type Importer,
  importTranscriptFile,
  runImport,
  type WriteOptions,
} from "./index.ts";
import type {
  ConversationMessage,
  ImportedSession,
  ImporterOptions,
} from "./types.ts";

const WRITE: WriteOptions = {
  treeRoot: "share.projects",
  sessionsNodeName: "agent_sessions",
  fullTranscript: false,
  dryRun: false,
  verbose: false,
};

/** A mock engine backed by an in-memory id→row store, mimicking the server. */
function mockEngine() {
  const store = new Map<
    string,
    { id: string; meta: Record<string, unknown>; content: string }
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
      // The server's conditional upsert: insert new ids; replace an existing
      // row when its meta value for `replaceIfMetaDiffers` differs; else skip.
      batchCreate: async (p: {
        memories: Array<{
          id: string;
          meta: Record<string, unknown>;
          content: string;
        }>;
        replaceIfMetaDiffers?: string;
      }) => {
        const ids: string[] = [];
        const updatedIds: string[] = [];
        for (const m of p.memories) {
          const existing = store.get(m.id);
          if (!existing) {
            store.set(m.id, { id: m.id, meta: m.meta, content: m.content });
            ids.push(m.id);
          } else if (
            p.replaceIfMetaDiffers !== undefined &&
            existing.meta[p.replaceIfMetaDiffers] !==
              m.meta[p.replaceIfMetaDiffers]
          ) {
            store.set(m.id, { id: m.id, meta: m.meta, content: m.content });
            updatedIds.push(m.id);
          }
        }
        return { ids, updatedIds };
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

/** An importer whose discoverSessions yields one fixed session (the `me import claude` path). */
function discoverImporter(session: ImportedSession): Importer {
  return {
    tool: "claude",
    defaultSource: "",
    discoverSessions: async function* () {
      yield session;
    },
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

  // The hook (importTranscriptFile) and `me import claude` (runImport) must be
  // idempotent w.r.t. each other: both derive the same tree + deterministic ids
  // from the same parse, so importing a session via one path and then the other
  // inserts nothing the second time. Guards the shared-derivation assumption.
  test("hook capture then `me import claude` over the same session is a no-op", async () => {
    const { client, store } = mockEngine();
    const s = session(["a", "b", "c"]);

    await importTranscriptFile(client, importerFor(s), "/x.jsonl", WRITE);
    expect(store.size).toBe(3);

    const res = await runImport(
      client,
      discoverImporter(s),
      {} as ImporterOptions,
      WRITE,
    );
    expect(res.inserted).toBe(0);
    expect(res.skipped).toBe(3);
    expect(store.size).toBe(3);
  });

  test("`me import claude` then hook capture over the same session is a no-op", async () => {
    const { client, store } = mockEngine();
    const s = session(["a", "b", "c"]);

    const res = await runImport(
      client,
      discoverImporter(s),
      {} as ImporterOptions,
      WRITE,
    );
    expect(res.inserted).toBe(3);
    expect(store.size).toBe(3);

    const out = await importTranscriptFile(
      client,
      importerFor(s),
      "/x.jsonl",
      WRITE,
    );
    expect(out?.inserted).toBe(0);
    expect(store.size).toBe(3);
  });

  test("a stale importer_version is re-rendered in place (server-side upsert)", async () => {
    const { client, store } = mockEngine();
    const s = session(["a", "b", "c"]);
    await importTranscriptFile(client, importerFor(s), "/x.jsonl", WRITE);
    expect(store.size).toBe(3);

    // Simulate rows written by an older importer build.
    for (const row of store.values()) {
      row.meta = { ...row.meta, importer_version: "0" };
      row.content = "stale render";
    }

    // The high-water row is stale → no narrowing; the full plan is submitted
    // and the server's upsert rewrites every stale row in one pass.
    const out = await importTranscriptFile(
      client,
      importerFor(s),
      "/x.jsonl",
      WRITE,
    );
    expect(out?.updated).toBe(3);
    expect(out?.inserted).toBe(0);
    expect(out?.skipped).toBe(0);
    for (const row of store.values()) {
      expect(row.meta.importer_version).toBe("1");
      expect(row.content).not.toBe("stale render");
    }
  });
});
