/**
 * Shared "project memory pointer" writer for agent `init` commands.
 *
 * `me claude init` and `me opencode init` both upsert a marker-delimited managed
 * block into the project's agent rules file (CLAUDE.md / AGENTS.md) telling the
 * agent where this project's memories live and how to search them. The block
 * shape is identical across agents; only the filename, the managing-command name
 * in the marker, and the agent label in the copy differ — captured here as a
 * `MemoryPointerSpec` so there is one implementation.
 */
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { resolveCredentials } from "../credentials.ts";
import { GIT_HISTORY_NODE_NAME } from "../importers/git.ts";
import {
  DEFAULT_PRIVATE_TREE_ROOT,
  DEFAULT_SESSIONS_NODE_NAME,
} from "../importers/index.ts";
import { detectGitContext, ProjectRegistry } from "../importers/project.ts";

/** What distinguishes one agent's memory pointer from another's. */
export interface MemoryPointerSpec {
  /** Rules file to write, relative to the repo root (e.g. "CLAUDE.md"). */
  filename: string;
  /** The managing command, embedded in the start marker (e.g. "me claude init"). */
  managedBy: string;
  /** Agent label used in the body copy (e.g. "Claude Code", "OpenCode"). */
  agentLabel: string;
}

const startMarker = (managedBy: string): string =>
  `<!-- memory-engine:start (managed by \`${managedBy}\`) -->`;
const END_MARKER = "<!-- memory-engine:end -->";

/**
 * Normalize a tree (lenient wire form — dotted, slashed, or mixed, possibly
 * with stray separators) to the canonical slash display form for the pointer
 * block: `~`-rooted trees render as `~/a/b`, everything else as `/a/b`.
 * Mirrors `memoryPath`'s segmentation (`@memory.build/protocol/meta`).
 */
export function displayTree(tree: string): string {
  const segments = tree.split(/[/.]+/).filter((s) => s.length > 0);
  if (segments[0] === "~") return ["~", ...segments.slice(1)].join("/");
  return `/${segments.join("/")}`;
}

/**
 * Build the managed block that tells an agent where this project's memories
 * live and how to search them. `tree` may arrive in any lenient wire form
 * (`/share/projects/foo`, `share.projects.foo`, `~/projects/foo`) — it is
 * normalized to the canonical slash display form ({@link displayTree}) so the
 * rendered paths never mix separators; sub-nodes are joined with `/`. `space`
 * is the active space slug.
 */
export function buildMemoryPointerSection(
  spec: MemoryPointerSpec,
  rawTree: string,
  space?: string,
): string {
  const tree = displayTree(rawTree);
  const sessions = `${tree}/${DEFAULT_SESSIONS_NODE_NAME}`;
  const gitHistory = `${tree}/${GIT_HISTORY_NODE_NAME}`;
  const where = space ? `Memory Engine (space \`${space}\`)` : "Memory Engine";
  return [
    startMarker(spec.managedBy),
    "## Project memories (Memory Engine)",
    "",
    `Prior context for this project — including captured/imported ${spec.agentLabel}`,
    `sessions — is stored in ${where} under the tree:`,
    "",
    `    ${tree}`,
    "",
    `- Captured & imported agent sessions: \`${sessions}\``,
    `- Imported git commit history: \`${gitHistory}\``,
    `- Search them with the \`me_memory_search\` MCP tool (set \`tree\` to`,
    `  \`${tree}\`), or from a shell: \`me search "<query>" --tree '${tree}'\`.`,
    "",
    "Always consult these memories when exploring the codebase or starting a",
    "task: search them FIRST to recall earlier decisions and context before",
    "digging into the code.",
    END_MARKER,
    "",
  ].join("\n");
}

/**
 * The rules file's path for a given filename (the git repo root's when in a
 * repo, else the current directory's) — shared by {@link resolveMemoryPointer}
 * and {@link sameRulesFile} so both agree on where e.g. "CLAUDE.md" lives.
 */
export async function rulesFilePath(filename: string): Promise<string> {
  const cwd = process.cwd();
  const { gitRoot } = await detectGitContext(cwd);
  return join(gitRoot ?? cwd, filename);
}

/**
 * Resolve the rules file the memory pointer lives in and the managed section
 * to write.
 *
 * The pointer's tree matches where the imports/hooks actually write: the
 * project's `.me/config.yaml` `tree` when one is in scope, else per-slug
 * under the machine-wide `tree_root` override or the private `~/projects`
 * default — so the pointer never names a node the project's memories don't
 * land in.
 */
export async function resolveMemoryPointer(
  spec: MemoryPointerSpec,
  server?: string,
): Promise<{ filePath: string; section: string }> {
  const cwd = process.cwd();
  const creds = resolveCredentials(server);
  const { gitRoot } = await detectGitContext(cwd);
  const slug = creds.tree
    ? undefined
    : (await new ProjectRegistry().resolve(cwd)).slug;
  const tree =
    creds.tree ?? `${creds.treeRoot ?? DEFAULT_PRIVATE_TREE_ROOT}/${slug}`;
  const section = buildMemoryPointerSection(spec, tree, creds.activeSpace);
  const filePath = join(gitRoot ?? cwd, spec.filename);
  return { filePath, section };
}

/**
 * Whether two rules filenames (e.g. "CLAUDE.md" and "AGENTS.md") currently
 * resolve to the SAME underlying file — a common convention for projects
 * supporting multiple AI tools is symlinking one to the other so they only
 * maintain one set of instructions. Both specs share the exact same start
 * marker (`managedBy` is now harness-agnostic — see `commands/project.ts`),
 * so writing both independently into a symlinked pair wouldn't duplicate
 * anything, but it WOULD silently clobber one write with the other's
 * `agentLabel` wording, non-deterministically depending on step order.
 * Callers should offer only one of the two steps when this is true. Returns
 * `false` (not linked) when either file doesn't exist yet — nothing to
 * detect a link *to* until at least one side is real.
 */
export async function sameRulesFile(
  filenameA: string,
  filenameB: string,
): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([
      rulesFilePath(filenameA).then(realpath),
      rulesFilePath(filenameB).then(realpath),
    ]);
    return a === b;
  } catch {
    return false;
  }
}

/**
 * Whether the project's rules file already carries the exact managed section
 * this run would write — i.e. re-running would be a no-op. A present-but-stale
 * block (template change, different active space) does NOT count, so the step
 * stays offered and a re-run refreshes it.
 */
export async function memoryPointerUpToDate(
  spec: MemoryPointerSpec,
  server?: string,
): Promise<boolean> {
  const { filePath, section } = await resolveMemoryPointer(spec, server);
  try {
    const existing = await readFile(filePath, "utf8");
    return existing.includes(section);
  } catch {
    return false; // no rules file yet
  }
}

/**
 * The generic prefix every start marker shares, regardless of the managing
 * command embedded in it. Replacement matches on this prefix so a rename of
 * the managing command (`me claude init` → `me project init`) updates the
 * existing block in place instead of appending a duplicate.
 */
const START_MARKER_PREFIX = "<!-- memory-engine:start";

/**
 * Upsert the managed Memory Engine section into the project's rules file.
 *
 * Idempotent: if a marker block already exists — even one written under a
 * previous managing-command name — it is replaced in place; otherwise the
 * block is appended (creating the file if absent).
 */
export async function writeMemoryPointer(
  spec: MemoryPointerSpec,
  server?: string,
): Promise<void> {
  const { filePath, section } = await resolveMemoryPointer(spec, server);
  let existing = "";
  try {
    existing = await readFile(filePath, "utf8");
  } catch {
    existing = ""; // no file yet → create it
  }

  let next: string;
  const start = existing.indexOf(START_MARKER_PREFIX);
  if (start !== -1) {
    // Replace the existing managed block in place.
    const endMarker = existing.indexOf(END_MARKER, start);
    const end =
      endMarker === -1 ? existing.length : endMarker + END_MARKER.length;
    // Swallow a single trailing newline after the old block so we don't grow
    // blank lines on every re-run.
    const tail = existing[end] === "\n" ? end + 1 : end;
    next = existing.slice(0, start) + section + existing.slice(tail);
  } else if (existing.trim().length === 0) {
    next = section;
  } else {
    // Append after the existing content with one blank line of separation.
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    next = existing + sep + section;
  }

  await writeFile(filePath, next);
  clack.log.success(`Recorded project memory location in ${filePath}`);
}
