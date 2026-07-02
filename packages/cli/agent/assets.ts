/**
 * Canonical integration asset sources — ONE definition of each asset every
 * harness installs, rendered into the harness's native format/location by the
 * per-harness installers:
 *
 * - the `memory-engine` skill (SKILL.md — when/how to use the memory tools),
 * - the `memory-recall` command (an explicit "search memory" affordance;
 *   also rendered as a skill for harnesses whose commands are deprecated),
 * - the context snippet (the managed "memory pointer" block written into
 *   CLAUDE.md / AGENTS.md / GEMINI.md).
 *
 * Scope determines identity (design: HARNESS_INTEGRATION_DESIGN.md §2): at
 * project scope every embedded `me` CLI invocation carries `--as-agent .me`;
 * at user scope it doesn't. Renderers take `{ agentMode }` for that.
 *
 * Assets shared across harnesses (`.agents/skills/`, the project `AGENTS.md`
 * block) must carry harness-agnostic markers — see `managed.ts`.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { GIT_HISTORY_NODE_NAME } from "../importers/git.ts";
import { DEFAULT_SESSIONS_NODE_NAME } from "../importers/index.ts";
import { type BlockMarkers, markdownMarkers, renderBlock } from "./managed.ts";

/**
 * Scope-neutral marker identifying a whole file we manage (skills, commands,
 * generated plugins). Deliberately names neither the harness nor the command:
 * the same file may be written by any harness's `install` (user scope) or
 * `init` (project scope).
 */
export const ASSET_MARKER = "<!-- managed by the `me` CLI (memory-engine) -->";

/** Skill directory names (each dir must equal its skill `name`). */
export const SKILL_NAME = "memory-engine";
export const RECALL_SKILL_NAME = "memory-recall";
export const SKILL_FILENAME = "SKILL.md";

/** Filename of the recall command in markdown-command harnesses. */
export const RECALL_COMMAND_FILENAME = "memory-recall.md";

/**
 * The cross-harness shared skills dir — `.agents/skills` (project) /
 * `~/.agents/skills` (user), the agentskills.io convention read by OpenCode,
 * Codex, AND Gemini. The skill is written here ONCE and served to all three;
 * only Claude keeps its own copy (`.claude/skills/`, since Claude doesn't read
 * `.agents/skills`). One shared location also avoids the duplicate-skill-name
 * warning a harness raises when the same skill appears under two dirs it reads.
 */
export function sharedSkillsDir(
  scope: "user" | "project",
  projectRoot: string,
): string {
  const base = scope === "project" ? projectRoot : homedir();
  return join(base, ".agents", "skills");
}

/** Options shared by the renderers. */
export interface AssetRenderOptions {
  /** Project scope → embedded `me` CLI calls carry `--as-agent .me`. */
  agentMode: boolean;
}

/** The `me` CLI invocation prefix for embedded shell examples. */
export function meInvocation(opts: AssetRenderOptions): string {
  return opts.agentMode ? "me --as-agent .me" : "me";
}

// =============================================================================
// Skill: memory-engine
// =============================================================================

/** The `memory-engine` skill: when + how to use the memory tools. */
export function renderSkill(opts: AssetRenderOptions): string {
  const me = meInvocation(opts);
  return `---
name: ${SKILL_NAME}
description: Recall and store project knowledge in Memory Engine — search prior decisions, past agent sessions, and git history before exploring code or starting a task, and save durable learnings.
metadata:
  managed_by: me
---
${ASSET_MARKER}

## What I do

Memory Engine is this project's persistent memory. Captured/imported agent
sessions, imported git history, and saved notes live under the project's tree
(by default \`share.projects.<project>\`).

## When to use me

- Before exploring the codebase or starting a task: search FIRST to recall
  earlier decisions and context.
- When the user references past work, prior decisions, or "how we did X".
- After reaching a durable conclusion worth remembering.

## How

- Search: the \`me_memory_search\` tool (hybrid semantic + keyword). Scope with
  \`tree\` set to the project's path when known.
- Save: the \`me_memory_create\` tool — choose a deliberate \`tree\` (a \`share\`
  path to share with the space, or a \`~\` path to keep it private).
- From a shell you can also run \`${me} search "<query>"\` or \`${me} create\`.
`;
}

// =============================================================================
// Command: /memory-recall (+ skill form for harnesses without commands)
// =============================================================================

/** The recall prompt body, shared by the command and skill renderings.
 * `argsPlaceholder` is the harness's arguments-interpolation token. */
export function recallPromptBody(argsPlaceholder: string): string {
  return `Search Memory Engine for anything relevant to: ${argsPlaceholder}

Use the \`me_memory_search\` tool (hybrid semantic + keyword). Prefer scoping the
search to this project's tree when you know it. Summarize what you find — prior
decisions, past sessions, and related history — and note how it bears on the
current task before continuing.`;
}

/** The `/memory-recall` command as a markdown command file. */
export function renderRecallCommand(
  opts: { argsPlaceholder?: string } = {},
): string {
  return `---
description: Search Memory Engine for prior context on a topic
---
${ASSET_MARKER}

${recallPromptBody(opts.argsPlaceholder ?? "$ARGUMENTS")}
`;
}

/**
 * The recall affordance as a skill (for harnesses whose custom-prompt/command
 * mechanism is deprecated — Codex — or that share `.agents/skills/`).
 */
export function renderRecallSkill(): string {
  return `---
name: ${RECALL_SKILL_NAME}
description: Search Memory Engine for prior context on a topic the user asks about — prior decisions, past agent sessions, and related history.
metadata:
  managed_by: me
---
${ASSET_MARKER}

${recallPromptBody("the topic the user asked about")}
`;
}

// =============================================================================
// Context snippet (the memory pointer)
// =============================================================================

/** Managing-command names embedded in the snippet markers. Harness-agnostic
 * by design: shared context files (the repo `AGENTS.md`) get one block that
 * every harness's command recognizes. */
export const USER_SNIPPET_MANAGED_BY = "me install";
export const PROJECT_SNIPPET_MANAGED_BY = "me init";

export const userSnippetMarkers = (): BlockMarkers =>
  markdownMarkers(USER_SNIPPET_MANAGED_BY);
export const projectSnippetMarkers = (): BlockMarkers =>
  markdownMarkers(PROJECT_SNIPPET_MANAGED_BY);

/**
 * User variant — identity-neutral "you have memory". Written into the
 * harness's user-level context file by `me <harness> install`.
 */
export function renderUserContextSnippet(): string {
  return renderBlock(userSnippetMarkers(), [
    "You have persistent memory: Memory Engine, via the `me_memory_*` MCP tools.",
    "",
    "- Search memory (`me_memory_search`) before starting non-trivial work —",
    "  prior decisions, conventions, and gotchas are stored there.",
    "- Store durable knowledge (decisions, fixes, project facts) as you learn it.",
  ]);
}

/** Facts the project variant is templated from (resolved from `.me/config.yaml`
 * + the repo at init time). */
export interface ProjectSnippetFacts {
  /** The project's full tree (dot-separated ltree, e.g. `share.projects.foo`). */
  projectTree: string;
  /** Active space slug, when known. */
  space?: string;
  /** Whether the project runs in agent mode (a `.me` `agent:` is configured). */
  agentMode: boolean;
}

/**
 * Project variant — "this project has memory here", templated from
 * `.me/config.yaml`. Written into the repo's context file(s) by
 * `me <harness> init`. Re-rendering with the same facts is byte-identical, so
 * up-to-date checks are a simple `includes`.
 */
export function renderProjectContextSnippet(
  facts: ProjectSnippetFacts,
): string {
  const sessions = `${facts.projectTree}.${DEFAULT_SESSIONS_NODE_NAME}`;
  const gitHistory = `${facts.projectTree}.${GIT_HISTORY_NODE_NAME}`;
  const where = facts.space
    ? `Memory Engine (space \`${facts.space}\`)`
    : "Memory Engine";
  const me = meInvocation({ agentMode: facts.agentMode });
  const body = [
    "## Project memories (Memory Engine)",
    "",
    `This project has persistent memory (\`me_memory_*\` MCP tools) in ${where},`,
    "under the tree:",
    "",
    `    ${facts.projectTree}`,
    "",
    `- Captured & imported agent sessions: \`${sessions}\``,
    `- Imported git commit history: \`${gitHistory}\``,
    `- Search them with the \`me_memory_search\` MCP tool (set \`tree\` to`,
    `  \`${facts.projectTree}\`), or from a shell:`,
    `  \`${me} search "<query>" --tree ${facts.projectTree}\`.`,
    "",
    "Always consult these memories when exploring the codebase or starting a",
    "task: search them FIRST to recall earlier decisions and context before",
    "digging into the code.",
  ];
  if (facts.agentMode) {
    body.push(
      "",
      "Memory access here runs as the project's agent (`.me/config.yaml`",
      "`agent`); ad-hoc `me` CLI calls inherit this via `ME_AS_AGENT=.me`.",
    );
  }
  return renderBlock(projectSnippetMarkers(), body);
}

/**
 * Claude bridge variant: when the repo already carries the shared `AGENTS.md`
 * project block, Claude's init writes a minimal CLAUDE.md block that imports
 * it (Claude reads CLAUDE.md, not AGENTS.md; `@AGENTS.md` is Claude's import
 * syntax) instead of duplicating the content.
 */
export function renderClaudeImportSnippet(): string {
  return renderBlock(projectSnippetMarkers(), ["@AGENTS.md"]);
}
