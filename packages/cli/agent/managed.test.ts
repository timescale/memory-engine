/**
 * Tests for the managed-block/file engine (`agent/managed.ts`) — the shared
 * upsert/remove discipline behind every integration artifact.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasBlock,
  hashMarkers,
  managedFileInstalled,
  markdownMarkers,
  readJsonFile,
  removeBlock,
  removeBlockFromFile,
  removeManagedFile,
  renderBlock,
  updateJsonFile,
  upsertBlock,
  upsertBlockInFile,
  writeManagedFile,
} from "./managed.ts";

const MD = markdownMarkers("me init");
const HASH = hashMarkers("me init");
const block = renderBlock(MD, ["line one", "line two"]);

describe("markers", () => {
  test("embed the managing command, not a harness name", () => {
    expect(MD.start).toBe(
      "<!-- >>> memory-engine (managed by `me init`) >>> -->",
    );
    expect(HASH.start).toBe("# >>> memory-engine (managed by `me init`) >>>");
  });

  test("renderBlock wraps the body and ends with a newline", () => {
    expect(block).toBe(`${MD.start}\nline one\nline two\n${MD.end}\n`);
  });
});

describe("upsertBlock", () => {
  test("null/empty existing → the block is the whole content", () => {
    expect(upsertBlock(null, block, MD)).toBe(block);
    expect(upsertBlock("  \n", block, MD)).toBe(block);
  });

  test("appends to foreign content with one blank line", () => {
    expect(upsertBlock("# Title\n", block, MD)).toBe(`# Title\n\n${block}`);
    expect(upsertBlock("# Title", block, MD)).toBe(`# Title\n\n${block}`);
  });

  test("replaces an existing block in place (idempotent — no growth)", () => {
    const doc = `before\n\n${block}\nafter\n`;
    const once = upsertBlock(doc, block, MD);
    const twice = upsertBlock(once, block, MD);
    expect(twice).toBe(once);
    expect(once.indexOf(MD.start)).toBe(once.lastIndexOf(MD.start));
  });

  test("replaces stale content between the markers", () => {
    const stale = renderBlock(MD, ["OLD"]);
    const doc = `head\n\n${stale}tail\n`;
    const next = upsertBlock(doc, block, MD);
    expect(next).toContain("line one");
    expect(next).not.toContain("OLD");
    expect(next).toContain("head");
    expect(next).toContain("tail");
  });
});

describe("removeBlock", () => {
  test("returns content unchanged when no block", () => {
    expect(removeBlock("plain\n", MD)).toBe("plain\n");
  });

  test("removes the block, keeping surrounding content", () => {
    const doc = `head\n\n${block}tail\n`;
    expect(removeBlock(doc, MD)).toBe("head\n\ntail\n");
  });

  test("returns null when nothing meaningful remains", () => {
    expect(removeBlock(block, MD)).toBeNull();
  });

  test("boilerplate filter treats a shebang as non-meaningful", () => {
    const script = `#!/bin/sh\n${renderBlock(HASH, ["(me import git &)"])}`;
    expect(removeBlock(script, HASH, (l) => l === "#!/bin/sh")).toBeNull();
  });
});

describe("file-level ops", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "me-managed-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("upsertBlockInFile: installed → unchanged → updated round-trip", async () => {
    const file = join(dir, "deep", "AGENTS.md");
    expect(await upsertBlockInFile(file, block, MD)).toBe("installed");
    expect(await upsertBlockInFile(file, block, MD)).toBe("unchanged");
    const v2 = renderBlock(MD, ["new body"]);
    expect(await upsertBlockInFile(file, v2, MD)).toBe("updated");
    expect(await readFile(file, "utf8")).toBe(v2);
  });

  test("removeBlockFromFile: removes ours, deletes an empty file", async () => {
    const file = join(dir, "AGENTS.md");
    await writeFile(file, `# Mine\n\n${block}`);
    expect(await removeBlockFromFile(file, MD)).toBe("removed");
    expect(await readFile(file, "utf8")).toBe("# Mine\n\n");
    // Now only the block:
    await writeFile(file, block);
    expect(await removeBlockFromFile(file, MD)).toBe("removed");
    await expect(stat(file)).rejects.toBeDefined();
    expect(await removeBlockFromFile(file, MD)).toBe("absent");
  });

  test("writeManagedFile refuses to overwrite an unmanaged file", async () => {
    const file = join(dir, "SKILL.md");
    await writeFile(file, "someone else's skill\n");
    await expect(
      writeManagedFile(file, "MARKER content\n", "MARKER"),
    ).rejects.toThrow(/not managed/);
    // force overrides
    expect(
      await writeManagedFile(file, "MARKER content\n", "MARKER", {
        force: true,
      }),
    ).toBe("updated");
    expect(await managedFileInstalled(file, "MARKER")).toBe(true);
  });

  test("writeManagedFile + removeManagedFile round-trip", async () => {
    const file = join(dir, "skills", "memory-engine", "SKILL.md");
    expect(await writeManagedFile(file, "MARKER v1\n", "MARKER")).toBe(
      "installed",
    );
    expect(await writeManagedFile(file, "MARKER v1\n", "MARKER")).toBe(
      "unchanged",
    );
    expect(await writeManagedFile(file, "MARKER v2\n", "MARKER")).toBe(
      "updated",
    );
    expect(await removeManagedFile(file, "MARKER")).toBe("removed");
    expect(await removeManagedFile(file, "MARKER")).toBe("absent");
  });

  test("writeManagedFile rejects content missing its own marker", async () => {
    await expect(
      writeManagedFile(join(dir, "x.md"), "no marker\n", "MARKER"),
    ).rejects.toThrow(/missing its marker/);
  });

  test("updateJsonFile creates, merges, preserves unrelated keys", async () => {
    const file = join(dir, "settings.json");
    await updateJsonFile(file, (c) => {
      c.env = { ME_AS_AGENT: ".me" };
    });
    await writeFile(
      file,
      JSON.stringify({ theme: "dark", env: { OTHER: "1" } }, null, 2),
    );
    await updateJsonFile(file, (c) => {
      c.env = { ...(c.env as Record<string, unknown>), ME_AS_AGENT: ".me" };
    });
    const parsed = await readJsonFile(file);
    expect(parsed).toEqual({
      theme: "dark",
      env: { OTHER: "1", ME_AS_AGENT: ".me" },
    });
  });

  test("readJsonFile: null when absent, throws on non-object", async () => {
    expect(await readJsonFile(join(dir, "missing.json"))).toBeNull();
    const file = join(dir, "arr.json");
    await writeFile(file, "[1,2]");
    await expect(readJsonFile(file)).rejects.toThrow(/not a JSON object/);
  });
});

describe("hasBlock", () => {
  test("detects by start marker", () => {
    expect(hasBlock(block, MD)).toBe(true);
    expect(hasBlock("nope", MD)).toBe(false);
  });
});
