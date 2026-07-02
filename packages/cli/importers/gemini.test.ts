/**
 * Tests for the Gemini CLI importer — parses the JSONL `chats/` transcript
 * format into normalized sessions.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geminiImporter } from "./gemini.ts";
import type { ImporterOptions, ImporterStats } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "me-gemini-"));
  dirs.push(d);
  return d;
}

const META = {
  sessionId: "abc123",
  projectHash: "hash",
  startTime: "2026-06-30T10:00:00.000Z",
  lastUpdated: "2026-06-30T10:05:00.000Z",
  kind: "main",
  directories: ["/repo/foo"],
};

async function writeJsonl(rows: unknown[]): Promise<string> {
  const dir = join(tmp(), "hash", "chats");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "session-2026-06-30T10-00-abc123.jsonl");
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n"));
  return file;
}

describe("geminiImporter.parseFile", () => {
  test("parses user + gemini turns, skips info/error, maps roles", async () => {
    const file = await writeJsonl([
      META,
      {
        id: "m1",
        timestamp: "2026-06-30T10:00:01.000Z",
        type: "user",
        content: "How does auth work?",
      },
      {
        id: "i1",
        timestamp: "2026-06-30T10:00:02.000Z",
        type: "info",
        content: "tokens: 5",
      },
      {
        id: "m2",
        timestamp: "2026-06-30T10:00:03.000Z",
        type: "gemini",
        model: "gemini-2.5-pro",
        content: [
          { text: "It uses JWTs." },
          { thought: true, text: "recall the rotation design" },
        ],
      },
    ]);
    const session = await geminiImporter.parseFile?.(file);
    expect(session).not.toBeNull();
    if (!session) return;
    expect(session.tool).toBe("gemini");
    expect(session.sessionId).toBe("abc123");
    expect(session.cwd).toBe("/repo/foo");
    expect(session.provider).toBe("google");
    expect(session.model).toBe("gemini-2.5-pro");
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toMatchObject({
      role: "user",
      messageId: "m1",
    });
    const assistant = session.messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.blocks.find((b) => b.kind === "text")?.text).toBe(
      "It uses JWTs.",
    );
    expect(
      assistant?.blocks.find((b) => b.kind === "thinking")?.text,
    ).toContain("rotation");
  });

  test("expands functionCall/functionResponse + toolCalls into blocks", async () => {
    const file = await writeJsonl([
      META,
      {
        id: "m1",
        timestamp: "2026-06-30T10:00:03.000Z",
        type: "gemini",
        content: [{ functionCall: { name: "read_file", args: { path: "x" } } }],
        toolCalls: [{ name: "grep", args: { q: "foo" }, result: "match" }],
      },
    ]);
    const session = await geminiImporter.parseFile?.(file);
    const blocks = session?.messages[0]?.blocks ?? [];
    expect(
      blocks.some((b) => b.kind === "tool_use" && b.toolName === "read_file"),
    ).toBe(true);
    expect(
      blocks.some((b) => b.kind === "tool_use" && b.toolName === "grep"),
    ).toBe(true);
    expect(
      blocks.some((b) => b.kind === "tool_result" && b.text === "match"),
    ).toBe(true);
  });

  test("ignores $set / $rewindTo records", async () => {
    const file = await writeJsonl([
      META,
      {
        id: "m1",
        timestamp: "2026-06-30T10:00:01.000Z",
        type: "user",
        content: "hi",
      },
      { $set: { lastUpdated: "2026-06-30T11:00:00.000Z" } },
      { $rewindTo: "m1" },
    ]);
    const session = await geminiImporter.parseFile?.(file);
    expect(session?.messages).toHaveLength(1);
    expect(session?.endedAt).toBe("2026-06-30T11:00:00.000Z");
  });

  test("returns null for a transcript with no message turns", async () => {
    const file = await writeJsonl([META]);
    expect(await geminiImporter.parseFile?.(file)).toBeNull();
  });
});

describe("geminiImporter.discoverSessions", () => {
  test("finds session files under chats/ dirs", async () => {
    const file = await writeJsonl([
      META,
      {
        id: "m1",
        timestamp: "2026-06-30T10:00:01.000Z",
        type: "user",
        content: "hi",
      },
    ]);
    // The tmp root is two levels up from the chats/ dir.
    const root = join(file, "..", "..", "..");
    const stats: ImporterStats = {
      totalFiles: 0,
      yielded: 0,
      skipped: {},
      errors: [],
    };
    const opts = {
      source: root,
      fullTranscript: false,
      includeSidechains: false,
      includeTempCwd: true,
      includeTrivial: true,
    } as ImporterOptions;
    const sessions = [];
    for await (const s of geminiImporter.discoverSessions(opts, stats)) {
      sessions.push(s);
    }
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe("abc123");
  });
});
