/**
 * OpenCode importer fixture tests.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  opencodeImporter,
  parseSessionById,
  resolveSessionFile,
} from "./opencode.ts";
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

const SQLITE_TIMES = {
  sessionStart: 1770500000000,
  userMessage: 1770500001000,
  assistantMessage: 1770500003000,
  assistantTextPart: 1770500004000,
  assistantReasoningPart: 1770500003500,
  assistantToolPart: 1770500005000,
  sessionEnd: 1770500009000,
};

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

function sqliteOptions(
  source: string,
  overrides: Partial<ImporterOptions> = {},
): ImporterOptions {
  return baseOptions({ source, ...overrides });
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

function createSqliteFixture(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "me-opencode-sqlite-"));
  const dbPath = join(dir, "opencode.db");
  const db = new Database(dbPath, { create: true, strict: true });
  try {
    db.run(`create table project (
      id text primary key,
      worktree text not null,
      vcs text,
      name text,
      icon_url text,
      icon_color text,
      time_created integer not null,
      time_updated integer not null,
      time_initialized integer,
      sandboxes text not null
    )`);
    db.run(`create table session (
      id text primary key,
      project_id text not null,
      parent_id text,
      slug text not null,
      directory text not null,
      title text not null,
      version text not null,
      share_url text,
      summary_additions integer,
      summary_deletions integer,
      summary_files integer,
      summary_diffs text,
      revert text,
      permission text,
      time_created integer not null,
      time_updated integer not null,
      time_compacting integer,
      time_archived integer,
      workspace_id text,
      path text,
      agent text,
      model text,
      cost real default 0 not null,
      tokens_input integer default 0 not null,
      tokens_output integer default 0 not null,
      tokens_reasoning integer default 0 not null,
      tokens_cache_read integer default 0 not null,
      tokens_cache_write integer default 0 not null,
      metadata text
    )`);
    db.run(`create table message (
      id text primary key,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null
    )`);
    db.run(`create table part (
      id text primary key,
      message_id text not null,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null
    )`);
    db.run(
      `insert into project (id, worktree, vcs, name, time_created, time_updated, sandboxes)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [
        "projSqlite",
        "/Users/test/sqlite-project",
        "git",
        "SQLite Project",
        SQLITE_TIMES.sessionStart,
        SQLITE_TIMES.sessionEnd,
        "[]",
      ],
    );
    db.run(
      `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated, agent, model)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "ses_sqlite",
        "projSqlite",
        "sqlite-lake",
        "/Users/test/sqlite-project",
        "SQLite-backed OpenCode session",
        "1.18.1",
        SQLITE_TIMES.sessionStart,
        SQLITE_TIMES.sessionEnd,
        "build",
        JSON.stringify({ id: "claude-opus-4-7", providerID: "anthropic" }),
      ],
    );
    db.run(
      `insert into message (id, session_id, time_created, time_updated, data)
       values (?, ?, ?, ?, ?)`,
      [
        "msg_user",
        "ses_sqlite",
        SQLITE_TIMES.userMessage,
        SQLITE_TIMES.userMessage,
        JSON.stringify({
          role: "user",
          time: { created: SQLITE_TIMES.userMessage },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-opus-4-7" },
        }),
      ],
    );
    db.run(
      `insert into message (id, session_id, time_created, time_updated, data)
       values (?, ?, ?, ?, ?)`,
      [
        "msg_assistant",
        "ses_sqlite",
        SQLITE_TIMES.assistantMessage,
        SQLITE_TIMES.assistantMessage,
        JSON.stringify({
          role: "assistant",
          time: { created: SQLITE_TIMES.assistantMessage },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-opus-4-7" },
        }),
      ],
    );
    db.run(
      `insert into part (id, message_id, session_id, time_created, time_updated, data)
       values (?, ?, ?, ?, ?, ?)`,
      [
        "prt_user",
        "msg_user",
        "ses_sqlite",
        SQLITE_TIMES.userMessage,
        SQLITE_TIMES.userMessage,
        JSON.stringify({
          type: "text",
          text: "Import my current OpenCode sessions.",
          time: { start: SQLITE_TIMES.userMessage },
        }),
      ],
    );
    db.run(
      `insert into part (id, message_id, session_id, time_created, time_updated, data)
       values (?, ?, ?, ?, ?, ?)`,
      [
        "prt_tool",
        "msg_assistant",
        "ses_sqlite",
        SQLITE_TIMES.assistantToolPart,
        SQLITE_TIMES.assistantToolPart,
        JSON.stringify({
          type: "tool",
          tool: "bash",
          time: { start: SQLITE_TIMES.assistantToolPart },
          state: {
            input: { command: "sqlite3 opencode.db '.tables'" },
            output: "project session message part",
          },
        }),
      ],
    );
    db.run(
      `insert into part (id, message_id, session_id, time_created, time_updated, data)
       values (?, ?, ?, ?, ?, ?)`,
      [
        "prt_reasoning",
        "msg_assistant",
        "ses_sqlite",
        SQLITE_TIMES.assistantReasoningPart,
        SQLITE_TIMES.assistantReasoningPart,
        JSON.stringify({
          type: "reasoning",
          text: "Need to read the SQLite tables.",
          time: { start: SQLITE_TIMES.assistantReasoningPart },
        }),
      ],
    );
    db.run(
      `insert into part (id, message_id, session_id, time_created, time_updated, data)
       values (?, ?, ?, ?, ?, ?)`,
      [
        "prt_text",
        "msg_assistant",
        "ses_sqlite",
        SQLITE_TIMES.assistantTextPart,
        SQLITE_TIMES.assistantTextPart,
        JSON.stringify({
          type: "text",
          text: "I found the OpenCode SQLite tables.",
          time: { start: SQLITE_TIMES.assistantTextPart },
        }),
      ],
    );
  } finally {
    db.close();
  }
  return { dir, dbPath };
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

  test("imports current SQLite-backed sessions", async () => {
    const { dir, dbPath } = createSqliteFixture();
    try {
      const { sessions, stats } = await collect(sqliteOptions(dbPath));
      expect(stats.totalFiles).toBe(1);
      expect(sessions).toHaveLength(1);
      const s = sessions[0];
      if (!s) return;
      expect(s.sessionId).toBe("ses_sqlite");
      expect(s.title).toBe("SQLite-backed OpenCode session");
      expect(s.cwd).toBe("/Users/test/sqlite-project");
      expect(s.toolVersion).toBe("1.18.1");
      expect(s.model).toBe("claude-opus-4-7");
      expect(s.provider).toBe("anthropic");
      expect(s.agentMode).toBe("build");
      expect(s.sourceFile).toBe(`${dbPath}#session/ses_sqlite`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports invalid SQLite sources as parse errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "me-opencode-bad-sqlite-"));
    try {
      writeFileSync(join(dir, "opencode.db"), "not a sqlite database");
      const { sessions, stats } = await collect(sqliteOptions(dir));
      expect(sessions).toHaveLength(0);
      expect(stats.errors).toHaveLength(1);
      expect(stats.skipped.parse_error).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not treat message ids as SQLite model ids", async () => {
    const { dir, dbPath } = createSqliteFixture();
    const db = new Database(dbPath, { strict: true });
    let closed = false;
    try {
      db.run("update session set model = null where id = ?", ["ses_sqlite"]);
      db.run("update message set data = ? where id = ?", [
        JSON.stringify({
          id: "msg_user",
          role: "user",
          time: { created: SQLITE_TIMES.userMessage },
          providerID: "anthropic",
        }),
        "msg_user",
      ]);
      db.run("update message set data = ? where id = ?", [
        JSON.stringify({
          id: "msg_assistant",
          role: "assistant",
          time: { created: SQLITE_TIMES.assistantMessage },
          providerID: "anthropic",
        }),
        "msg_assistant",
      ]);
      db.close();
      closed = true;

      const { sessions } = await collect(sqliteOptions(dbPath));
      const s = sessions[0];
      if (!s) return;
      expect(s.model).toBeUndefined();
      expect(s.provider).toBe("anthropic");
    } finally {
      if (!closed) db.close(false);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("orders SQLite messages and parts by their creation times", async () => {
    const { dir, dbPath } = createSqliteFixture();
    try {
      const { sessions } = await collect(sqliteOptions(dbPath));
      const s = sessions[0];
      if (!s) return;
      expect(s.messages.map((m) => m.messageId)).toEqual([
        "msg_user",
        "msg_assistant",
      ]);
      const asst = s.messages[1];
      expect(asst?.blocks.map((b) => b.kind)).toEqual([
        "thinking",
        "text",
        "tool_use",
        "tool_result",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prefers opencode.db when a data dir also contains legacy storage noise", async () => {
    const { dir } = createSqliteFixture();
    try {
      mkdirSync(join(dir, "storage"), { recursive: true });
      const { sessions, stats } = await collect(sqliteOptions(dir));
      expect(stats.totalFiles).toBe(1);
      expect(sessions.map((s) => s.sessionId)).toEqual(["ses_sqlite"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("opencode parseFile (live-capture path)", () => {
  test("parseFile yields the same session as discoverSessions", async () => {
    const sessionFile = join(FIXTURE_DIR, "session", "projA", "ses_test.json");
    const parsed = await opencodeImporter.parseFile?.(sessionFile);
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    const { sessions } = await collect(baseOptions());
    const bulk = sessions[0];
    if (!bulk) return;

    // The live-capture parse must be byte-for-byte equivalent to bulk import,
    // so a hook capture and `me import opencode` reconcile onto the same rows.
    expect(parsed).toEqual(bulk);
  });

  test("parseSessionById reads one current SQLite session", async () => {
    const { dir } = createSqliteFixture();
    try {
      const parsed = await parseSessionById("ses_sqlite", dir);
      expect(parsed).not.toBeNull();
      if (!parsed) return;
      expect(parsed.sessionId).toBe("ses_sqlite");
      expect(parsed.messages.map((m) => m.messageId)).toEqual([
        "msg_user",
        "msg_assistant",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveSessionFile", () => {
  test("locates a session file by id across project dirs", async () => {
    const found = await resolveSessionFile("ses_test", FIXTURE_DIR);
    expect(found).toBe(join(FIXTURE_DIR, "session", "projA", "ses_test.json"));
  });

  test("returns null for an unknown session id", async () => {
    const found = await resolveSessionFile("ses_nope", FIXTURE_DIR);
    expect(found).toBeNull();
  });

  test("returns null when the storage tree is absent", async () => {
    const found = await resolveSessionFile(
      "ses_test",
      join(FIXTURE_DIR, "does-not-exist"),
    );
    expect(found).toBeNull();
  });
});
