/**
 * Static OpenCode asset templates installed by `me opencode init`:
 *
 * - a `/memory-recall` custom command (markdown prompt template), and
 * - a `memory-engine` Agent Skill (SKILL.md),
 *
 * both written into the global OpenCode config dirs. They make the MCP memory
 * tools discoverable: the command is an explicit "search memory" affordance, the
 * skill teaches the agent the tree layout + when to consult memory. Each carries
 * a managed marker so `init` can report "already installed" and refresh in place.
 */

/** Marker (in the body) identifying assets we manage, for idempotent re-init. */
export const ASSET_MARKER = "<!-- managed by `me opencode init` -->";

/** Filename of the recall command (its basename is the command name). */
export const RECALL_COMMAND_FILENAME = "memory-recall.md";

/** Skill directory + file (the dir name must equal the skill `name`). */
export const SKILL_NAME = "memory-engine";
export const SKILL_FILENAME = "SKILL.md";

/** The `/memory-recall` command: prompt the agent to search Memory Engine. */
export function renderRecallCommand(): string {
  return `---
description: Search Memory Engine for prior context on a topic
---
${ASSET_MARKER}

Search Memory Engine for anything relevant to: $ARGUMENTS

Use the \`me_memory_search\` tool (hybrid semantic + keyword). Prefer scoping the
search to this project's tree when you know it. Summarize what you find — prior
decisions, past sessions, and related history — and note how it bears on the
current task before continuing.
`;
}

/** The `memory-engine` skill: when + how to use the memory tools. */
export function renderSkill(): string {
  return `---
name: ${SKILL_NAME}
description: Recall and store project knowledge in Memory Engine — search prior decisions, past agent sessions, and git history before exploring code or starting a task, and save durable learnings.
metadata:
  managed_by: me opencode init
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
- From a shell you can also run \`me search "<query>"\` or \`me create\`.
`;
}
