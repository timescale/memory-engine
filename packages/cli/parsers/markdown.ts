/**
 * Markdown parser for memory import.
 *
 * Parses markdown files with optional YAML frontmatter.
 */
import { parse as yamlParse } from "yaml";
import { splitFrontmatterBlock } from "./frontmatter.ts";
import type { ParsedMemory } from "./index.ts";
import { parseTemporalInput, validateMemoryObject } from "./validation.ts";

/**
 * Parse a markdown file with optional YAML frontmatter.
 */
export function parseMarkdown(
  input: string,
  filename?: string,
): ParsedMemory[] {
  const block = splitFrontmatterBlock(input);

  let frontmatter: Record<string, unknown> = {};
  let content: string;

  if (block) {
    try {
      frontmatter = yamlParse(block.yaml) || {};
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid YAML frontmatter${filename ? ` in ${filename}` : ""}: ${msg}`,
      );
    }
    content = block.body.trim();
  } else {
    content = input.trim();
  }

  if (!content) {
    throw new Error(`Empty content${filename ? ` in ${filename}` : ""}`);
  }

  const obj = { content, ...frontmatter };
  const memory = validateMemoryObject(obj, filename);

  if (memory.temporal !== undefined) {
    memory.temporal = parseTemporalInput(memory.temporal, "md", filename);
  }

  return [memory];
}
