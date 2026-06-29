/**
 * Tests for the Slab zip source handling: archive detection, safe extraction
 * (markdown-only, zip-slip rejection), lone-wrapper descent, and end-to-end
 * resolve + walk parity with a plain directory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { walkSlabDir } from "./slab.ts";
import {
  decodeZipName,
  descendLoneWrapper,
  extractSlabZip,
  isZipSource,
  resolveSlabSource,
} from "./slab-zip.ts";

/** Write a zip with the given entries to `path`. */
async function writeZip(
  path: string,
  entries: Record<string, string>,
): Promise<void> {
  const data: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(entries)) {
    data[name] = strToU8(content);
  }
  await writeFile(path, zipSync(data));
}

describe("slab-zip", () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "slab-zip-test-"));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  describe("isZipSource", () => {
    test("true for a real zip file", async () => {
      const zip = join(work, "export.zip");
      await writeZip(zip, { "a.md": "# A" });
      expect(await isZipSource(zip)).toBe(true);
    });

    test("true even without a .zip extension (magic sniff)", async () => {
      const zip = join(work, "export.bin");
      await writeZip(zip, { "a.md": "# A" });
      expect(await isZipSource(zip)).toBe(true);
    });

    test("false for a directory", async () => {
      expect(await isZipSource(work)).toBe(false);
    });

    test("false for a non-zip file", async () => {
      const txt = join(work, "notes.md");
      await writeFile(txt, "# not a zip");
      expect(await isZipSource(txt)).toBe(false);
    });

    test("false for a missing path", async () => {
      expect(await isZipSource(join(work, "nope.zip"))).toBe(false);
    });
  });

  describe("extractSlabZip", () => {
    test("writes only .md entries, preserving nested paths", async () => {
      const zip = join(work, "export.zip");
      await writeZip(zip, {
        "Topic/post.md": "# Post",
        "Topic/notes.txt": "ignored",
        "root.md": "# Root",
        "img/logo.png": "binary-ish",
      });
      const dest = join(work, "out");
      mkdirSync(dest);
      const count = await extractSlabZip(zip, dest);
      expect(count).toBe(2);
      expect(existsSync(join(dest, "Topic/post.md"))).toBe(true);
      expect(existsSync(join(dest, "root.md"))).toBe(true);
      expect(existsSync(join(dest, "Topic/notes.txt"))).toBe(false);
      expect(existsSync(join(dest, "img/logo.png"))).toBe(false);
    });

    test("rejects a zip-slip entry (escapes the destination)", async () => {
      const zip = join(work, "evil.zip");
      await writeZip(zip, { "../evil.md": "# escape" });
      const dest = join(work, "out");
      mkdirSync(dest);
      await expect(extractSlabZip(zip, dest)).rejects.toThrow(/Unsafe path/);
      expect(existsSync(join(work, "evil.md"))).toBe(false);
    });

    test("rejects an absolute-path entry", async () => {
      const zip = join(work, "abs.zip");
      await writeZip(zip, { "/etc/whatever.md": "# nope" });
      const dest = join(work, "out");
      mkdirSync(dest);
      await expect(extractSlabZip(zip, dest)).rejects.toThrow(/Unsafe path/);
    });

    test("recovers UTF-8 filenames mojibaked by a non-UTF-8-flagged zip", async () => {
      // Simulate fflate's latin1 decode of a UTF-8 entry name: take the real
      // UTF-8 bytes of the filename and map each byte to a latin1 char, which
      // is exactly the string fflate hands back.
      const realName = "Customer Playbook 📒 — notes.md";
      const utf8 = new TextEncoder().encode(realName);
      const latin1Name = Array.from(utf8, (b) => String.fromCharCode(b)).join(
        "",
      );
      expect(decodeZipName(latin1Name)).toBe(realName);

      const zip = join(work, "emoji.zip");
      // zipSync keys are encoded by fflate; emulate the mangled key directly.
      await writeFile(zip, zipSync({ [latin1Name]: strToU8("# body") }));
      const dest = join(work, "out");
      mkdirSync(dest);
      await extractSlabZip(zip, dest);
      // The file lands under its real UTF-8 name, so a re-read is not mojibake.
      const seen: string[] = [];
      for await (const f of walkSlabDir(dest)) seen.push(f.relPath);
      expect(seen).toEqual([realName]);
    });
  });

  describe("descendLoneWrapper", () => {
    test("descends into a single wrapper directory", () => {
      const root = join(work, "x");
      mkdirSync(join(root, "wrapper", "Topic"), { recursive: true });
      expect(descendLoneWrapper(root)).toBe(join(root, "wrapper"));
    });

    test("does not descend when a top-level .md exists", () => {
      const root = join(work, "y");
      mkdirSync(join(root, "wrapper"), { recursive: true });
      // root has both a dir and a file → not a lone wrapper.
      writeFileSync(join(root, "loose.md"), "# loose");
      expect(descendLoneWrapper(root)).toBe(root);
    });

    test("ignores __MACOSX / dotfiles when finding a lone wrapper", () => {
      const root = join(work, "z");
      mkdirSync(join(root, "wrapper", "Topic"), { recursive: true });
      mkdirSync(join(root, "__MACOSX"), { recursive: true });
      expect(descendLoneWrapper(root)).toBe(join(root, "wrapper"));
    });
  });

  describe("resolveSlabSource", () => {
    test("a directory passes through with a no-op cleanup", async () => {
      const dir = join(work, "dir");
      mkdirSync(dir);
      const resolved = await resolveSlabSource(dir);
      expect(resolved.dir).toBe(dir);
      await resolved.cleanup(); // should not throw / not remove the dir
      expect(existsSync(dir)).toBe(true);
    });

    test("a zip extracts to a temp dir, descends the wrapper, and cleans up", async () => {
      const zip = join(work, "export.zip");
      await writeZip(zip, {
        "Export/Engineering/onboarding.md": "# Onboarding",
        "Export/2023-01-31.md": "weekly",
      });
      const resolved = await resolveSlabSource(zip);
      // Wrapper "Export" was stripped, so topics sit at the root.
      const seen: string[] = [];
      for await (const f of walkSlabDir(resolved.dir)) seen.push(f.relPath);
      expect(seen.sort()).toEqual([
        "2023-01-31.md",
        "Engineering/onboarding.md",
      ]);
      await resolved.cleanup();
      expect(existsSync(resolved.dir)).toBe(false);
    });

    test("throws for a non-directory, non-zip path", async () => {
      const txt = join(work, "plain.txt");
      await writeFile(txt, "hello");
      await expect(resolveSlabSource(txt)).rejects.toThrow(
        /Not a directory or .zip/,
      );
    });
  });
});
