/**
 * `me import git-hook` — install a managed git post-commit hook that keeps a
 * repo's git-history memories current.
 *
 * The hook runs `me import git` in the background after every commit:
 * best-effort, asynchronous, silent — it never blocks or fails a commit, and
 * the embedded invocation is absolute so GUI git clients (no shell PATH)
 * work. Because the import is high-water incremental, ANY fire catches up the
 * entire backlog (including commits that arrived via pull/rebase), so a
 * single post-commit hook suffices — no post-merge/post-rewrite matrix.
 *
 * The hook lives in the repo's effective hooks directory as a
 * marker-delimited managed block (created, replaced in place, or appended to
 * a foreign hook — the same upsert discipline as the CLAUDE.md pointer).
 * Repos using a committed hooks manager (`core.hooksPath`, e.g. husky) are
 * refused with instructions instead of writing into committed files.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { getOutputFormat, output } from "../output.ts";
import { handleError } from "../util.ts";

const execFileAsync = promisify(execFile);

/** Markers delimiting the managed block inside the hook script. */
const HOOK_START = "# >>> memory-engine (managed by `me import git-hook`) >>>";
const HOOK_END = "# <<< memory-engine <<<";

const SHEBANG = "#!/bin/sh";

/** Quote a path for /bin/sh (double quotes; escapes embedded `"` and `\`). */
function shQuote(path: string): string {
  return `"${path.replace(/([\\"$`])/g, "\\$1")}"`;
}

/**
 * The absolute invocation embedded into the hook, resolved from how this
 * process is running: the compiled `me` binary, a source run (`bun
 * packages/cli/index.ts` — dev and tests), or `me` on PATH.
 */
export function resolveMeInvocation(): string {
  if (basename(process.execPath) === "me") return shQuote(process.execPath);
  const entry = process.argv[1];
  if (entry && /\.(ts|js)$/.test(entry) && isAbsolute(entry)) {
    return `${shQuote(process.execPath)} ${shQuote(entry)}`;
  }
  const onPath = Bun.which("me");
  if (onPath) return shQuote(onPath);
  throw new Error(
    "Cannot resolve the `me` binary to embed in the hook — install it on PATH first.",
  );
}

/** The managed block (ends with a newline). */
export function buildHookBlock(invocation: string): string {
  return [
    HOOK_START,
    "# Best-effort and asynchronous: never blocks or fails the commit.",
    `(${invocation} import git >/dev/null 2>&1 &)`,
    HOOK_END,
    "",
  ].join("\n");
}

/**
 * Upsert the managed block into an existing hook script (null = no file).
 * Fresh file → shebang + block; markers present → replaced in place;
 * foreign hook → block appended (a foreign script that exits early never
 * reaches it — documented limitation).
 */
export function upsertHookScript(
  existing: string | null,
  block: string,
): string {
  if (existing === null || existing.trim().length === 0) {
    return `${SHEBANG}\n${block}`;
  }
  const start = existing.indexOf(HOOK_START);
  if (start !== -1) {
    const endMarker = existing.indexOf(HOOK_END, start);
    const end =
      endMarker === -1 ? existing.length : endMarker + HOOK_END.length;
    // Swallow a single trailing newline so re-installs don't grow the file.
    const tail = existing[end] === "\n" ? end + 1 : end;
    return existing.slice(0, start) + block + existing.slice(tail);
  }
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block;
}

/**
 * Remove the managed block. Returns the remaining script, or null when
 * nothing but the shebang would remain (caller deletes the file).
 */
export function removeHookBlock(existing: string): string | null {
  const start = existing.indexOf(HOOK_START);
  if (start === -1) return existing;
  const endMarker = existing.indexOf(HOOK_END, start);
  const end = endMarker === -1 ? existing.length : endMarker + HOOK_END.length;
  const tail = existing[end] === "\n" ? end + 1 : end;
  const remaining = existing.slice(0, start) + existing.slice(tail);
  const meaningful = remaining
    .split("\n")
    .filter((l) => l.trim().length > 0 && l.trim() !== SHEBANG);
  return meaningful.length === 0 ? null : remaining;
}

async function git(repo: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
      timeout: 5000,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Whether the git-hook init step should be offered for `cwd`: inside a git
 * repo, no committed hooks manager, and the managed block not yet installed.
 */
export async function isGitHookInstallable(cwd: string): Promise<boolean> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return false;
  if (await git(root, ["config", "core.hooksPath"])) return false;
  const hooksFile = await resolveHooksFile(root);
  try {
    const existing = await readFile(hooksFile, "utf8");
    return !existing.includes(HOOK_START);
  } catch {
    return true; // no hook file yet
  }
}

/** The effective post-commit path (worktree-aware via --git-path). */
async function resolveHooksFile(root: string): Promise<string> {
  const hooksDir =
    (await git(root, ["rev-parse", "--git-path", "hooks"])) ?? "";
  const abs = isAbsolute(hooksDir) ? hooksDir : join(root, hooksDir);
  return join(abs, "post-commit");
}

/** Options for one install/remove run. */
export interface GitHookOptions {
  repo?: string;
  remove?: boolean;
  /** Soft-skip when the target isn't a git repo (used by `me claude init`). */
  skipIfNotRepo?: boolean;
}

/**
 * Install (or remove) the managed post-commit hook. Exported so
 * `me claude init` can run it as a setup step. Purely local — no server
 * auth required.
 */
export async function runGitHookInstall(
  opts: GitHookOptions,
  globalOpts: Record<string, unknown>,
): Promise<void> {
  const fmt = getOutputFormat(globalOpts);
  const repoPath = opts.repo ?? process.cwd();

  const root = await git(repoPath, ["rev-parse", "--show-toplevel"]);
  if (!root) {
    if (opts.skipIfNotRepo) {
      if (fmt === "text") {
        clack.log.info(
          `${repoPath} is not a git repository — skipping git hook install`,
        );
      }
      return;
    }
    handleError(new Error(`${repoPath} is not a git repository`), fmt);
  }

  const hooksFile = await resolveHooksFile(root);

  if (opts.remove) {
    let existing: string;
    try {
      existing = await readFile(hooksFile, "utf8");
    } catch {
      output({ hooksFile, action: "absent" }, fmt, () =>
        clack.log.info(`No hook installed at ${hooksFile}`),
      );
      return;
    }
    const remaining = removeHookBlock(existing);
    if (remaining === existing) {
      output({ hooksFile, action: "absent" }, fmt, () =>
        clack.log.info(`No managed block found in ${hooksFile}`),
      );
      return;
    }
    if (remaining === null) await rm(hooksFile);
    else await writeFile(hooksFile, remaining);
    output({ hooksFile, action: "removed" }, fmt, () =>
      clack.log.success(`Removed the memory-engine hook from ${hooksFile}`),
    );
    return;
  }

  // A committed hooks manager (husky, lefthook, …) owns the hook path —
  // don't write into committed files; tell the user what to add instead.
  const hooksPath = await git(root, ["config", "core.hooksPath"]);
  if (hooksPath) {
    handleError(
      new Error(
        `This repo routes hooks through core.hooksPath (${hooksPath}) — a committed hooks manager likely owns it.\n` +
          `Add this line to its post-commit hook instead:\n` +
          `  me import git >/dev/null 2>&1 &`,
      ),
      fmt,
    );
  }

  let existing: string | null = null;
  try {
    existing = await readFile(hooksFile, "utf8");
  } catch {
    // no hook yet
  }
  const updated = existing !== null && existing.includes(HOOK_START);
  const next = upsertHookScript(
    existing,
    buildHookBlock(resolveMeInvocation()),
  );
  await mkdir(join(hooksFile, ".."), { recursive: true });
  await writeFile(hooksFile, next);
  await chmod(hooksFile, 0o755);

  output({ hooksFile, action: updated ? "updated" : "installed" }, fmt, () => {
    clack.log.success(
      `${updated ? "Updated" : "Installed"} the post-commit hook at ${hooksFile}`,
    );
    console.log(
      "  Each commit now triggers a background `me import git` (incremental,",
    );
    console.log(
      "  silent, never blocks the commit). Remove with: me import git-hook --remove",
    );
  });
}

/** `me import git-hook` subcommand factory. */
export function createGitHookCommand(): Command {
  return new Command("git-hook")
    .description(
      "install a git post-commit hook that keeps git history memories current",
    )
    .argument("[repo]", "path inside the repo (default: cwd)")
    .option("--remove", "remove the managed hook block")
    .action(async (repoArg: string | undefined, opts, cmdRef) => {
      const globalOpts = cmdRef.optsWithGlobals();
      await runGitHookInstall(
        { repo: repoArg, remove: opts.remove === true },
        globalOpts,
      );
    });
}
