/**
 * JSON parser for memory import.
 *
 * Supports single object, array, and NDJSON (newline-delimited).
 * Uses Bun's built-in JSONL parser for NDJSON detection.
 */
import type { ParsedMemory } from "./index.ts";
import { parseTemporalInput, validateMemoryObject } from "./validation.ts";

/**
 * Parse JSON content (single, array, or NDJSON).
 */
export function parseJson(input: string, filename?: string): ParsedMemory[] {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new Error(`Empty JSON content${filename ? ` in ${filename}` : ""}`);
  }

  // Detect NDJSON: multiple lines all starting with {
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > 1 && lines.every((line) => line.trim().startsWith("{"))) {
    return parseNdjson(trimmed, filename);
  }

  // Try standard JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    // If standard parse fails and we have multiple lines, try NDJSON
    if (lines.length > 1) {
      try {
        return parseNdjson(trimmed, filename);
      } catch {
        // Fall through to original error
      }
    }
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON${filename ? ` in ${filename}` : ""}: ${msg}`);
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new Error(`Empty memory array${filename ? ` in ${filename}` : ""}`);
    }
    return parsed.map((item, index) => {
      const location = `${filename ? `${filename} ` : ""}item ${index}`;
      const memory = validateMemoryObject(item, filename, index);
      if (memory.temporal !== undefined) {
        memory.temporal = parseTemporalInput(memory.temporal, "json", location);
      }
      return memory;
    });
  }

  if (typeof parsed === "object" && parsed !== null) {
    const memory = validateMemoryObject(parsed, filename);
    if (memory.temporal !== undefined) {
      memory.temporal = parseTemporalInput(memory.temporal, "json", filename);
    }
    return [memory];
  }

  throw new Error(
    `Invalid JSON: expected object or array${filename ? ` in ${filename}` : ""}`,
  );
}

/**
 * Parse NDJSON using Bun's built-in JSONL parser.
 */
function parseNdjson(input: string, filename?: string): ParsedMemory[] {
  let items: unknown[];
  try {
    items = Bun.JSONL.parse(input);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid NDJSON${filename ? ` in ${filename}` : ""}: ${msg}`,
    );
  }

  if (items.length === 0) {
    throw new Error(
      `No valid memories found${filename ? ` in ${filename}` : ""}`,
    );
  }

  return items.map((item, index) => {
    const location = `${filename ? `${filename} ` : ""}item ${index}`;
    const memory = validateMemoryObject(item, filename, index);
    if (memory.temporal !== undefined) {
      memory.temporal = parseTemporalInput(memory.temporal, "json", location);
    }
    return memory;
  });
}
