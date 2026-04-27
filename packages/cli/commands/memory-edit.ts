/**
 * Memory edit workflow — opens a memory in the user's editor.
 *
 * Fetches a memory, formats as Markdown with YAML frontmatter,
 * opens in $VISUAL/$EDITOR/vim, and updates on save.
 * Re-opens editor on parse or API errors with error comments.
 */
import { spawnSync } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import type { EngineClient } from "../client.ts";
import { parseMarkdown } from "../parsers/markdown.ts";

interface ParsedMemory {
  id?: string;
  content: string;
  meta?: Record<string, unknown>;
  tree?: string;
  temporal?: { start: string; end?: string };
}

/**
 * Get the editor command from environment.
 * Priority: VISUAL > EDITOR > vim
 */
function getEditor(): string {
  return process.env.VISUAL || process.env.EDITOR || "vim";
}

/**
 * Open a file in the user's editor and wait for it to close.
 */
function openInEditor(filePath: string): boolean {
  const editor = getEditor();
  const result = spawnSync(editor, [filePath], { stdio: "inherit" });
  return result.status === 0;
}

/**
 * Format a memory as Markdown with YAML frontmatter for editing.
 */
function formatForEdit(memory: Record<string, unknown>): string {
  const frontmatter: Record<string, unknown> = { id: memory.id };
  if (memory.createdAt) frontmatter.created_at = memory.createdAt;
  if (
    memory.meta &&
    typeof memory.meta === "object" &&
    Object.keys(memory.meta as object).length > 0
  ) {
    frontmatter.meta = memory.meta;
  }
  if (memory.tree) frontmatter.tree = memory.tree;
  if (memory.temporal) frontmatter.temporal = memory.temporal;

  const yaml = yamlStringify(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${memory.content}\n`;
}

/**
 * Prepend an error comment to content for re-editing.
 */
function prependError(content: string, error: string): string {
  const errorComment = `<!-- ERROR: ${error} -->\n<!-- Fix the error below and save to retry, or quit without saving to abort -->\n`;
  const cleaned = stripErrorComments(content);
  return errorComment + cleaned;
}

/**
 * Strip error comments from content before parsing.
 */
function stripErrorComments(content: string): string {
  return content
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("<!-- ERROR:") &&
        !line.startsWith("<!-- Fix the error"),
    )
    .join("\n");
}

/**
 * Check if a memory has changed.
 */
function hasChanges(
  original: Record<string, unknown>,
  parsed: ParsedMemory,
): boolean {
  if (original.content !== parsed.content) return true;

  const origMeta = (original.meta as Record<string, unknown>) || {};
  const parsedMeta = parsed.meta || {};
  if (JSON.stringify(origMeta) !== JSON.stringify(parsedMeta)) return true;

  const origTree = (original.tree as string) || null;
  const parsedTree = parsed.tree || null;
  if (origTree !== parsedTree) return true;

  const origTemporal = original.temporal as {
    start: string;
    end?: string | null;
  } | null;
  const parsedTemporal = parsed.temporal ?? null;
  if (!origTemporal && !parsedTemporal) return false;
  if (!origTemporal || !parsedTemporal) return true;
  if (origTemporal.start !== parsedTemporal.start) return true;
  if ((origTemporal.end ?? null) !== (parsedTemporal.end ?? null)) return true;

  return false;
}

/**
 * Edit a memory interactively.
 */
export async function editMemory(
  engine: EngineClient,
  id: string,
): Promise<void> {
  const original = await engine.memory.get({ id });
  let content = formatForEdit(original as unknown as Record<string, unknown>);

  const tempFile = join(tmpdir(), `memory-edit-${Date.now()}.md`);

  try {
    while (true) {
      await writeFile(tempFile, content, "utf-8");

      const success = openInEditor(tempFile);
      if (!success) {
        console.error("Editor exited with error. Aborting.");
        process.exit(1);
      }

      const editedContent = await Bun.file(tempFile).text();
      const cleanedContent = stripErrorComments(editedContent);

      // Parse edited content
      let parsed: ParsedMemory;
      try {
        const results = parseMarkdown(cleanedContent);
        const first = results[0];
        if (!first) throw new Error("Empty content");
        parsed = first;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        content = prependError(editedContent, msg);
        continue;
      }

      // Validate ID hasn't changed
      if (parsed.id && parsed.id !== id) {
        content = prependError(
          editedContent,
          `ID cannot be changed (expected ${id}, got ${parsed.id})`,
        );
        continue;
      }

      // Check for changes
      if (!hasChanges(original as unknown as Record<string, unknown>, parsed)) {
        console.log("No changes detected. Memory unchanged.");
        return;
      }

      // Build update params and call API
      const updateParams: Record<string, unknown> = { id };
      updateParams.content = parsed.content;
      if (parsed.meta !== undefined) updateParams.meta = parsed.meta;
      if (parsed.tree !== undefined) updateParams.tree = parsed.tree;
      if (parsed.temporal !== undefined)
        updateParams.temporal = parsed.temporal;

      try {
        await engine.memory.update(
          updateParams as Parameters<typeof engine.memory.update>[0],
        );
        console.log(`Memory ${id} updated.`);
        return;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        content = prependError(editedContent, msg);
      }
    }
  } finally {
    try {
      await unlink(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}
