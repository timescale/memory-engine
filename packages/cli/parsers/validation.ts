/**
 * Validation for parsed memory objects.
 *
 * Validates structure and normalizes temporal formats without Zod dependency.
 */
import type { ImportFormat, ParsedMemory } from "./index.ts";

const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate a memory object from parsed input.
 */
export function validateMemoryObject(
  obj: unknown,
  filename?: string,
  index?: number,
): ParsedMemory {
  const location =
    index !== undefined
      ? `${filename ? `${filename} ` : ""}item ${index}`
      : filename || "";
  const inLoc = location ? ` in ${location}` : "";

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error(`Invalid memory: expected object${inLoc}`);
  }

  const record = obj as Record<string, unknown>;

  // Content is required
  if (
    record.content === undefined ||
    typeof record.content !== "string" ||
    record.content.length === 0
  ) {
    throw new Error(`Missing required field 'content'${inLoc}`);
  }

  // Validate ID if present
  if (record.id !== undefined) {
    if (typeof record.id !== "string" || !UUIDV7_RE.test(record.id)) {
      throw new Error(`Invalid ID: must be a valid UUIDv7${inLoc}`);
    }
  }

  // Validate meta if present
  if (record.meta !== undefined) {
    if (
      typeof record.meta !== "object" ||
      record.meta === null ||
      Array.isArray(record.meta)
    ) {
      throw new Error(`Invalid meta: must be an object${inLoc}`);
    }
  }

  // Validate tree if present
  if (record.tree !== undefined) {
    if (typeof record.tree !== "string") {
      throw new Error(`Invalid tree: must be a string${inLoc}`);
    }
  }

  return {
    content: record.content,
    ...(record.id !== undefined ? { id: record.id as string } : {}),
    ...(record.meta !== undefined
      ? { meta: record.meta as Record<string, unknown> }
      : {}),
    ...(record.tree !== undefined ? { tree: record.tree as string } : {}),
    ...(record.temporal !== undefined
      ? { temporal: record.temporal as { start: string; end?: string } }
      : {}),
  };
}

/**
 * Parse temporal input from various formats.
 *
 * JSON accepts: string | [string, string?] | {start, end?}
 * YAML/Markdown accepts: string | [string, string?]
 *
 * All normalize to {start: string, end?: string}.
 */
export function parseTemporalInput(
  value: unknown,
  format: ImportFormat,
  location?: string,
): { start: string; end?: string } {
  const inLoc = location ? ` in ${location}` : "";

  // String → {start}
  if (typeof value === "string") {
    return { start: value };
  }

  // Array → {start, end?}
  if (Array.isArray(value)) {
    if (value.length === 1 && typeof value[0] === "string") {
      return { start: value[0] };
    }
    if (
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string"
    ) {
      return { start: value[0], end: value[1] };
    }
    throw new Error(
      `Invalid temporal: array must have 1 or 2 string elements${inLoc}`,
    );
  }

  // Object → {start, end?} (only for JSON format)
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if (format !== "json") {
      throw new Error(
        `Invalid temporal: object format only supported in JSON${inLoc}`,
      );
    }
    const obj = value as Record<string, unknown>;
    if (typeof obj.start !== "string") {
      throw new Error(`Invalid temporal: 'start' must be a string${inLoc}`);
    }
    if (obj.end !== undefined && typeof obj.end !== "string") {
      throw new Error(`Invalid temporal: 'end' must be a string${inLoc}`);
    }
    return {
      start: obj.start,
      ...(obj.end ? { end: obj.end as string } : {}),
    };
  }

  throw new Error(
    `Invalid temporal: expected string, array, or object${inLoc}`,
  );
}
