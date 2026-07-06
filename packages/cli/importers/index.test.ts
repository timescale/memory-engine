/**
 * Tests for importer helpers in `index.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { MemoryClient } from "../client.ts";
import {
  dedupBy,
  type Importer,
  runImport,
  type SessionRouter,
  type WriteOptions,
} from "./index.ts";
import type { ImportedSession, ImporterOptions } from "./types.ts";

const byKey = (item: { key: string }) => item.key;

describe("dedupBy", () => {
  test("returns input unchanged when all keys are unique", () => {
    const items = [
      { key: "a", value: 1 },
      { key: "b", value: 2 },
      { key: "c", value: 3 },
    ];
    const result = dedupBy(items, byKey);
    expect(result.unique).toEqual(items);
    expect(result.duplicates).toBe(0);
  });

  test("removes duplicates, keeping the first occurrence", () => {
    const a1 = { key: "a", value: 1 };
    const a2 = { key: "a", value: 2 }; // duplicate key, different payload
    const b = { key: "b", value: 3 };
    const result = dedupBy([a1, a2, b], byKey);
    expect(result.unique).toEqual([a1, b]);
    expect(result.duplicates).toBe(1);
  });

  test("counts duplicates accurately when a key repeats more than twice", () => {
    const result = dedupBy(
      [{ key: "a" }, { key: "a" }, { key: "a" }, { key: "b" }],
      byKey,
    );
    expect(result.unique.map((u) => u.key)).toEqual(["a", "b"]);
    expect(result.duplicates).toBe(2);
  });

  test("handles empty input", () => {
    const result = dedupBy([] as { key: string }[], byKey);
    expect(result.unique).toEqual([]);
    expect(result.duplicates).toBe(0);
  });

  test("preserves insertion order across distinct keys", () => {
    const items = [
      { key: "c" },
      { key: "a" },
      { key: "b" },
      { key: "a" }, // dup
      { key: "d" },
    ];
    const result = dedupBy(items, byKey);
    expect(result.unique.map((u) => u.key)).toEqual(["c", "a", "b", "d"]);
    expect(result.duplicates).toBe(1);
  });
});

// =============================================================================
// runImport + SessionRouter — per-session engine/tree routing mechanics
// =============================================================================

const IMPORTER_OPTS: ImporterOptions = {
  fullTranscript: false,
  includeSidechains: false,
  includeTempCwd: false,
  includeTrivial: false,
};

const WRITE: WriteOptions = {
  treeRoot: "~/projects",
  sessionsNodeName: "agent_sessions",
  fullTranscript: false,
  dryRun: false,
  verbose: false,
};

/** A capturing engine: records every batchCreate payload it receives. */
function capturingEngine() {
  const writes: Array<{ tree: string; name?: string }> = [];
  const engine = {
    memory: {
      batchCreate: async (p: {
        memories: Array<{ id: string; tree: string; name?: string }>;
      }) => {
        for (const m of p.memories) writes.push({ tree: m.tree, name: m.name });
        return {
          results: p.memories.map((m) => ({
            id: m.id,
            status: "inserted" as const,
          })),
        };
      },
    },
  } as unknown as MemoryClient;
  return { engine, writes };
}

function session(id: string, cwd: string | undefined): ImportedSession {
  return {
    tool: "claude",
    sessionId: id,
    cwd,
    sourceFile: `/src/${id}.jsonl`,
    messages: [
      {
        messageId: `${id}-m1`,
        role: "user",
        timestamp: "2026-02-01T00:00:00.000Z",
        blocks: [{ kind: "text", text: `hello from ${id}` }],
      },
    ],
  } as unknown as ImportedSession;
}

function importerOf(sessions: ImportedSession[]): Importer {
  return {
    tool: "claude",
    defaultSource: "/src",
    // biome-ignore lint/correctness/useYield: trivial generator
    async *discoverSessions() {
      for (const s of sessions) yield s;
    },
  } as unknown as Importer;
}

describe("runImport with a SessionRouter", () => {
  test("each session writes through its route's engine under its route's tree", async () => {
    const base = capturingEngine();
    const other = capturingEngine();
    const router: SessionRouter = (cwd) =>
      cwd === "/work/team-repo"
        ? {
            route: {
              engine: other.engine,
              tree: "/share/projects/team",
              treeRoot: "~/projects",
            },
          }
        : {
            route: {
              engine: base.engine,
              tree: undefined,
              treeRoot: "~/projects",
            },
          };

    const result = await runImport(
      base.engine,
      importerOf([
        session("s1", "/work/solo-repo"),
        session("s2", "/work/team-repo"),
      ]),
      IMPORTER_OPTS,
      WRITE,
      undefined,
      router,
    );

    expect(result.sessionsProcessed).toBe(2);
    // s1 → base engine, private per-slug layout.
    expect(base.writes).toHaveLength(1);
    expect(base.writes[0]?.tree).toStartWith(
      "~/projects.solo_repo.agent_sessions.",
    );
    // s2 → the routed engine, directly under the project tree (no slug).
    expect(other.writes).toHaveLength(1);
    expect(other.writes[0]?.tree).toStartWith(
      "/share/projects/team.agent_sessions.",
    );
  });

  test("a skip decision tallies the reason and writes nothing", async () => {
    const base = capturingEngine();
    const router: SessionRouter = (cwd) =>
      cwd === "/work/evil"
        ? { skip: "untrusted_me_server" }
        : {
            route: {
              engine: base.engine,
              tree: undefined,
              treeRoot: "~/projects",
            },
          };

    const result = await runImport(
      base.engine,
      importerOf([session("ok", "/work/fine"), session("bad", "/work/evil")]),
      IMPORTER_OPTS,
      WRITE,
      undefined,
      router,
    );

    expect(result.sessionsProcessed).toBe(1);
    expect(result.discovery.skipped.untrusted_me_server).toBe(1);
    expect(base.writes).toHaveLength(1);
    expect(base.writes[0]?.tree).toContain("fine");
  });

  test("without a router, behavior is unchanged (single engine, writeOptions tree)", async () => {
    const base = capturingEngine();
    const result = await runImport(
      base.engine,
      importerOf([session("s1", "/work/x")]),
      IMPORTER_OPTS,
      { ...WRITE, tree: "/share/projects/x" },
    );
    expect(result.sessionsProcessed).toBe(1);
    expect(base.writes[0]?.tree).toStartWith(
      "/share/projects/x.agent_sessions.",
    );
  });
});
