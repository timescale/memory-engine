/**
 * YAML parser for memory import.
 *
 * Supports single memory or array.
 */
import { parse as yamlParse } from "yaml";
import type { ParsedMemory } from "./index.ts";
import { parseTemporalInput, validateMemoryObject } from "./validation.ts";

/**
 * Parse YAML content (single object or array).
 */
export function parseYaml(input: string, filename?: string): ParsedMemory[] {
  let parsed: unknown;

  try {
    parsed = yamlParse(input);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid YAML${filename ? ` in ${filename}` : ""}: ${msg}`);
  }

  if (parsed === null || parsed === undefined) {
    throw new Error(`Empty YAML content${filename ? ` in ${filename}` : ""}`);
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new Error(`Empty memory array${filename ? ` in ${filename}` : ""}`);
    }
    return parsed.map((item, index) => {
      const location = `${filename ? `${filename} ` : ""}item ${index}`;
      const memory = validateMemoryObject(item, filename, index);
      if (memory.temporal !== undefined) {
        memory.temporal = parseTemporalInput(memory.temporal, "yaml", location);
      }
      return memory;
    });
  }

  if (typeof parsed === "object") {
    const memory = validateMemoryObject(parsed, filename);
    if (memory.temporal !== undefined) {
      memory.temporal = parseTemporalInput(memory.temporal, "yaml", filename);
    }
    return [memory];
  }

  throw new Error(
    `Invalid YAML: expected object or array${filename ? ` in ${filename}` : ""}`,
  );
}
