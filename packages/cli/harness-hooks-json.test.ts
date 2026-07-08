/**
 * Tests for the shared Codex/Gemini JSON hooks-file upsert.
 */
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type JsonHookEntry,
  upsertJsonHooksFile,
} from "./harness-hooks-json.ts";

const OUR_ENTRY: JsonHookEntry = {
  matcher: "^Bash$",
  hooks: [{ type: "command", command: "me codex env-hook", timeout: 10 }],
};

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "me-hooksjson-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("creates the file (and its dir) from scratch", () => {
  withTmpDir((dir) => {
    const path = join(dir, "nested", "hooks.json");
    const result = upsertJsonHooksFile(
      path,
      "PreToolUse",
      OUR_ENTRY,
      "me codex env-hook",
    );
    expect(result.changed).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed).toEqual({ hooks: { PreToolUse: [OUR_ENTRY] } });
  });
});

test("is a no-op (byte-identical) on a second install", () => {
  withTmpDir((dir) => {
    const path = join(dir, "hooks.json");
    upsertJsonHooksFile(path, "PreToolUse", OUR_ENTRY, "me codex env-hook");
    const mtimeBefore = readFileSync(path, "utf-8");
    const result = upsertJsonHooksFile(
      path,
      "PreToolUse",
      OUR_ENTRY,
      "me codex env-hook",
    );
    expect(result.changed).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(mtimeBefore);
  });
});

test("preserves other event keys and other entries in the same event", () => {
  withTmpDir((dir) => {
    const path = join(dir, "hooks.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "*",
              hooks: [{ type: "command", command: "other-tool" }],
            },
          ],
          PreToolUse: [
            {
              matcher: "^Write$",
              hooks: [{ type: "command", command: "someone-elses-hook" }],
            },
          ],
        },
      }),
    );
    upsertJsonHooksFile(path, "PreToolUse", OUR_ENTRY, "me codex env-hook");
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe(
      "someone-elses-hook",
    );
    expect(parsed.hooks.PreToolUse[1]).toEqual(OUR_ENTRY);
  });
});

test("replaces our own stale entry in place rather than duplicating it", () => {
  withTmpDir((dir) => {
    const path = join(dir, "hooks.json");
    const stale: JsonHookEntry = {
      matcher: "^Bash$",
      hooks: [{ type: "command", command: "me codex env-hook", timeout: 5 }],
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [stale] } }));

    const result = upsertJsonHooksFile(
      path,
      "PreToolUse",
      OUR_ENTRY,
      "me codex env-hook",
    );
    expect(result.changed).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0]).toEqual(OUR_ENTRY);
  });
});

test("throws on invalid JSON rather than silently replacing the file", () => {
  withTmpDir((dir) => {
    const path = join(dir, "hooks.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "{ not json");
    expect(() =>
      upsertJsonHooksFile(path, "PreToolUse", OUR_ENTRY, "me codex env-hook"),
    ).toThrow(/not valid JSON/);
    expect(readFileSync(path, "utf-8")).toBe("{ not json");
  });
});

test("throws when the file holds a non-object (e.g. an array)", () => {
  withTmpDir((dir) => {
    const path = join(dir, "hooks.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "[1, 2]");
    expect(() =>
      upsertJsonHooksFile(path, "PreToolUse", OUR_ENTRY, "me codex env-hook"),
    ).toThrow(/JSON object/);
    expect(existsSync(path)).toBe(true);
  });
});

test("Gemini's BeforeTool shape works identically (different event key)", () => {
  withTmpDir((dir) => {
    const path = join(dir, "settings.json");
    const geminiEntry: JsonHookEntry = {
      matcher: "run_shell_command",
      hooks: [{ type: "command", command: "me gemini env-hook" }],
    };
    upsertJsonHooksFile(path, "BeforeTool", geminiEntry, "me gemini env-hook");
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed).toEqual({ hooks: { BeforeTool: [geminiEntry] } });
  });
});
