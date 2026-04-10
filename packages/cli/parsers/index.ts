/**
 * Parser interface and format detection for memory import.
 *
 * Supports Markdown (with YAML frontmatter), YAML, JSON, and NDJSON.
 * Auto-detects format from file extension or content sniffing.
 */
import { parseJson } from "./json.ts";
import { parseMarkdown } from "./markdown.ts";
import { parseYaml } from "./yaml.ts";

/**
 * Parsed memory structure from any format.
 */
export interface ParsedMemory {
  id?: string;
  content: string;
  meta?: Record<string, unknown>;
  tree?: string;
  temporal?: { start: string; end?: string };
}

/**
 * Supported import formats.
 */
export type ImportFormat = "md" | "yaml" | "json";

/**
 * Parser function signature.
 */
export type Parser = (input: string, filename?: string) => ParsedMemory[];

const parsers: Record<ImportFormat, Parser> = {
  md: parseMarkdown,
  yaml: parseYaml,
  json: parseJson,
};

/**
 * Detect format from file extension.
 */
export function detectFormatFromExtension(
  filename: string,
): ImportFormat | null {
  const ext = filename.toLowerCase().split(".").pop();
  switch (ext) {
    case "md":
    case "markdown":
      return "md";
    case "yaml":
    case "yml":
      return "yaml";
    case "json":
    case "ndjson":
    case "jsonl":
      return "json";
    default:
      return null;
  }
}

/**
 * Detect format from content (for stdin).
 */
export function detectFormatFromContent(content: string): ImportFormat {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("---")) return "md";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  return "yaml";
}

/**
 * Parse content with automatic or specified format detection.
 */
export function parseContent(
  content: string,
  options: { format?: ImportFormat; filename?: string } = {},
): ParsedMemory[] {
  const { format, filename } = options;

  let detectedFormat: ImportFormat;
  if (format) {
    detectedFormat = format;
  } else if (filename) {
    const fromExt = detectFormatFromExtension(filename);
    detectedFormat = fromExt ?? detectFormatFromContent(content);
  } else {
    detectedFormat = detectFormatFromContent(content);
  }

  const parser = parsers[detectedFormat];
  return parser(content, filename);
}

export { parseJson } from "./json.ts";
export { parseMarkdown } from "./markdown.ts";
export {
  type PackEnvelope,
  type ParsedPack,
  parsePack,
  validatePackConstraints,
} from "./pack.ts";
export { parseTemporalInput, validateMemoryObject } from "./validation.ts";
export { parseYaml } from "./yaml.ts";
