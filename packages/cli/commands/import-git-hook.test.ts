/**
 * Tests for the retired hook's surviving cleanup helpers: block removal and
 * the on-disk detect/strip pair `me project ci` uses to migrate hooks
 * installed by older versions.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installedHookFile,
  removeHookBlock,
  stripHookBlock,
} from "./import-git-hook.ts";

const START = "# >>> memory-engine";

/** The exact block older versions wrote (see the retired installer). */
const LEGACY_BLOCK = [
  "# >>> memory-engine (managed by `me import git-hook`) >>>",
  "# Best-effort and asynchronous: never blocks or fails the commit.",
  '("/usr/local/bin/me" import git >/dev/null 2>&1 &)',
  "# <<< memory-engine <<<",
  "",
].join("\n");

describe("removeHookBlock", () => {
  test("returns null when only the shebang would remain", () => {
    expect(removeHookBlock(`#!/bin/sh\n${LEGACY_BLOCK}`)).toBeNull();
  });

  test("preserves foreign content", () => {
    const script = `#!/bin/sh\necho "their hook"\n${LEGACY_BLOCK}`;
    const remaining = removeHookBlock(script);
    expect(remaining).toContain('echo "their hook"');
    expect(remaining).not.toContain(START);
  });

  test("is a no-op on a script without the block", () => {
    const foreign = '#!/bin/sh\necho "their hook"\n';
    expect(removeHookBlock(foreign)).toBe(foreign);
  });
});

describe("installedHookFile / stripHookBlock", () => {
  function makeRepo(): string {
    // realpath: git prints physical paths (macOS /var → /private/var), and
    // installedHookFile derives its result from git's answer.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "me-hookmig-")));
    execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
    return root;
  }

  test("detects a legacy block and strips it (file deleted when block-only)", async () => {
    const repo = makeRepo();
    const hooksFile = join(repo, ".git", "hooks", "post-commit");
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(hooksFile, `#!/bin/sh\n${LEGACY_BLOCK}`);

    expect(await installedHookFile(repo)).toBe(hooksFile);
    await stripHookBlock(hooksFile);
    expect(existsSync(hooksFile)).toBe(false);
    expect(await installedHookFile(repo)).toBeUndefined();
  });

  test("stripping preserves a foreign hook's own content", async () => {
    const repo = makeRepo();
    const hooksFile = join(repo, ".git", "hooks", "post-commit");
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(hooksFile, `#!/bin/sh\necho "theirs"\n${LEGACY_BLOCK}`);

    expect(await installedHookFile(repo)).toBe(hooksFile);
    await stripHookBlock(hooksFile);
    const remaining = await readFile(hooksFile, "utf8");
    expect(remaining).toContain('echo "theirs"');
    expect(remaining).not.toContain(START);
    expect(await installedHookFile(repo)).toBeUndefined();
  });

  test("undefined outside a repo / without a block; strip is idempotent", async () => {
    const plain = mkdtempSync(join(tmpdir(), "me-hookmig-plain-"));
    expect(await installedHookFile(plain)).toBeUndefined();

    const repo = makeRepo();
    expect(await installedHookFile(repo)).toBeUndefined();
    // Stripping a missing file is a clean no-op.
    await stripHookBlock(join(repo, ".git", "hooks", "post-commit"));
  });
});
