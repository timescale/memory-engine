/**
 * Unit tests for importTranscriptFile — the live-capture (Claude hook) path.
 *
 * Uses a fake importer (parseFile returns a synthetic session) + an in-memory
 * mock client that round-trips meta through the real buildMeta and simulates
 * the server's conditional upsert, so the watermark / incremental-delta /
 * version-bump re-render logic is exercised without a database.
 */
import { describe, expect, test } from "bun:test";
import { memoryPath } from "@memory.build/protocol/meta";
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

/** A mock engine backed by an in-memory store keyed on (tree, name), mimicking
 *  the server: named rows dedup on (tree, name), keeping the existing row's id. */
function mockEngine() {
  const store = new Map<
    string, // `${tree} ${name}`
    {
      id: string;
      tree: string;
      name: string;
      meta: Record<string, unknown>;
      content: string;
    }
  >();
  const client = {
    memory: {
      // Filter by source_session_id, order by id desc (server default for
      // filter-only — id encodes the message time), slice to limit.
      search: async (p: { meta?: Record<string, unknown>; limit?: number }) => {
        const sid = p.meta?.source_session_id;
        const all = [...store.values()]
          .filter((m) => m.meta.source_session_id === sid)
          .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        const limit = p.limit ?? 10;
        return { results: all.slice(0, limit), total: all.length, limit };
      },
      // The server's content-aware replace, keyed on (tree, name): insert a new
      // (tree, name) with the submitted id; for an existing slot under
      // onConflict 'replace', rewrite it (KEEPING the existing row's id) when
      // content or meta differ, else skip. importer_version lives in meta, so a
      // version bump makes meta differ and re-renders.
      batchCreate: async (p: {
        memories: Array<{
          id: string;
          tree: string;
          name: string;
          meta: Record<string, unknown>;
          content: string;
        }>;
        onConflict?: "error" | "replace" | "ignore";
      }) => {
        // One {id, status} per input, in input order (mirrors the server).
        const results: Array<{
          id: string;
          status: "inserted" | "updated" | "skipped";
        }> = [];
        for (const m of p.memories) {
          const key = `${m.tree} ${m.name}`;
          const existing = store.get(key);
          if (!existing) {
            store.set(key, {
              id: m.id,
              tree: m.tree,
              name: m.name,
              meta: m.meta,
              content: m.content,
            });
            results.push({ id: m.id, status: "inserted" });
          } else if (
            p.onConflict === "replace" &&
            (existing.content !== m.content ||
              JSON.stringify(existing.meta) !== JSON.stringify(m.meta))
          ) {
            store.set(key, { ...existing, meta: m.meta, content: m.content });
            // (tree, name) conflict keeps the existing row's id.
            results.push({ id: existing.id, status: "updated" });
          } else {
            // Existing slot, nothing differs (or not replacing) → no-op.
            results.push({ id: existing.id, status: "skipped" });
          }
        }
        return { results };
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

  test("tree nests sessions directly under it (no slug appended)", async () => {
    const { client, store } = mockEngine();
    await importTranscriptFile(
      client,
      importerFor(session(["a"])),
      "/x.jsonl",
      {
        ...WRITE,
        tree: "share.myteam.backend",
      },
    );
    const [row] = [...store.values()];
    // `<tree>.agent_sessions.<label>` — no per-project slug segment.
    expect(row?.tree.startsWith("share.myteam.backend.agent_sessions.")).toBe(
      true,
    );
  });

  test("without tree, sessions nest under <treeRoot>.<slug>", async () => {
    const { client, store } = mockEngine();
    await importTranscriptFile(
      client,
      importerFor(session(["a"])),
      "/x.jsonl",
      WRITE,
    );
    const [row] = [...store.values()];
    const segs = row?.tree.split(".") ?? [];
    // share . projects . <slug> . agent_sessions . <label>
    expect(segs[0]).toBe("share");
    expect(segs[1]).toBe("projects");
    expect(segs[3]).toBe("agent_sessions");
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
  // idempotent w.r.t. each other: both derive the same (tree, name) keys from
  // the same parse, so importing a session via one path and then the other
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

  test("stamps $thread on every message and $prev linking consecutive ones", async () => {
    const { client, store } = mockEngine();
    await importTranscriptFile(
      client,
      importerFor(session(["a", "b", "c"])),
      "/x.jsonl",
      WRITE,
    );
    const rows = [...store.values()];
    const byId = (id: string) =>
      rows.find((r) => r.meta.source_message_id === id);
    const a = byId("a");
    const b = byId("b");
    const c = byId("c");
    if (!a || !b || !c) throw new Error("expected three imported messages");

    // Every message shares the session's $thread grouping id.
    expect(rows.every((r) => r.meta.$thread === "sess-1")).toBe(true);
    // $prev links each message to the previous one's canonical path; the head
    // of the thread has none.
    expect(a.meta.$prev).toBeUndefined();
    expect(b.meta.$prev).toBe(memoryPath(a.tree, a.name));
    expect(c.meta.$prev).toBe(memoryPath(b.tree, b.name));
    // $next is never stored — the UI derives it from $prev.
    expect(rows.every((r) => !("$next" in r.meta))).toBe(true);
  });

  test("an incrementally-captured message links $prev back to the already-imported previous one", async () => {
    const { client, store } = mockEngine();
    // First capture: a, b, c.
    await importTranscriptFile(
      client,
      importerFor(session(["a", "b", "c"])),
      "/x.jsonl",
      WRITE,
    );
    // Live capture after message "d" is appended — only "d" is submitted
    // (the watermark narrows the plan to the new suffix).
    const out = await importTranscriptFile(
      client,
      importerFor(session(["a", "b", "c", "d"])),
      "/x.jsonl",
      WRITE,
    );
    expect(out?.inserted).toBe(1);

    const rows = [...store.values()];
    const byId = (id: string) =>
      rows.find((r) => r.meta.source_message_id === id);
    const c = byId("c");
    const d = byId("d");
    if (!c || !d) throw new Error("expected messages c and d");
    // Links are stamped over the full plan before the suffix slice, so the
    // incrementally-submitted "d" still points back at the already-stored "c".
    expect(d.meta.$prev).toBe(memoryPath(c.tree, c.name));
    expect(d.meta.$thread).toBe("sess-1");
  });
});
