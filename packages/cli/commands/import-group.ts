/**
 * `me import` — the umbrella group for getting data into Memory Engine.
 *
 * One subcommand per source:
 *
 *   me import memories <paths…>   file records (md/yaml/json/ndjson)
 *   me import claude              Claude Code sessions
 *   me import codex               Codex sessions
 *   me import opencode            OpenCode sessions
 *   me import git [repo]          git commit history
 *
 * There is deliberately no bare default: `me import <file>` does not parse.
 * The pre-group spellings stay registered as aliases built from the same
 * factories — `me memory import` (⇒ memories) and `me <tool> import`
 * (⇒ claude/codex/opencode) — so adding a source here is one subcommand,
 * never a new top-level command group.
 */
import { Command } from "commander";
import {
  createClaudeImportCommand,
  createCodexImportCommand,
  createOpenCodeImportCommand,
} from "./import.ts";
import { createGitImportCommand } from "./import-git.ts";
import { createGitHookCommand } from "./import-git-hook.ts";
import { createMemoryImportCommand } from "./memory-import.ts";

export function createImportCommand(): Command {
  const imp = new Command("import").description(
    "import memories, agent sessions, and git history",
  );
  imp.addCommand(createMemoryImportCommand("memories"));
  imp.addCommand(createClaudeImportCommand("claude"));
  imp.addCommand(createCodexImportCommand("codex"));
  imp.addCommand(createOpenCodeImportCommand("opencode"));
  imp.addCommand(createGitImportCommand());
  imp.addCommand(createGitHookCommand());
  imp.addHelpText(
    "after",
    "\nTo import memory files (the old `me import <file>`), use: me import memories <file>",
  );
  return imp;
}
