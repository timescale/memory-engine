/**
 * Pack parser — parses memory pack YAML files (v2 envelope format).
 *
 * Pack format:
 * ```yaml
 * name: my_pack
 * version: "1.0.0"
 * id-prefix: "019b0001"
 * format: 1
 * memories:
 *   - id: "019b0001-0001-7000-8000-000000000001"
 *     content: |
 *       The memory content...
 * ```
 */
import { parse as yamlParse } from "yaml";
import type { ParsedMemory } from "./index.ts";
import { parseTemporalInput, validateMemoryObject } from "./validation.ts";

// =============================================================================
// Types
// =============================================================================

export interface PackEnvelope {
  name: string;
  version: string;
  description?: string;
  idPrefix: string;
  format: number;
}

export interface ParsedPack {
  envelope: PackEnvelope;
  memories: ParsedMemory[];
}

// =============================================================================
// Validation Regexes
// =============================================================================

const PACK_NAME_RE = /^[a-z0-9_]+$/;
const ID_PREFIX_RE = /^[0-9a-f]{8}$/;

// =============================================================================
// Parser
// =============================================================================

/**
 * Parse a memory pack YAML file.
 *
 * Validates the envelope (name, version, id-prefix, format) and each memory.
 * Returns the envelope and parsed memories.
 */
export function parsePack(content: string, source?: string): ParsedPack {
  const inSrc = source ? ` in ${source}` : "";

  let parsed: unknown;
  try {
    parsed = yamlParse(content);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid YAML${inSrc}: ${msg}`);
  }

  if (parsed === null || parsed === undefined) {
    throw new Error(`Empty pack file${inSrc}`);
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    // Detect v1 flat-array format
    if (Array.isArray(parsed)) {
      throw new Error(
        `Pack uses old v1 flat-array format${inSrc}. Please migrate to v2 envelope format (see pack-authoring docs).`,
      );
    }
    throw new Error(`Invalid pack: expected object${inSrc}`);
  }

  const obj = parsed as Record<string, unknown>;

  // Validate envelope fields
  if (typeof obj.name !== "string" || !PACK_NAME_RE.test(obj.name)) {
    throw new Error(`Invalid pack name: must match [a-z0-9_]+${inSrc}`);
  }

  if (typeof obj.version !== "string" || obj.version.length === 0) {
    throw new Error(`Missing or empty pack version${inSrc}`);
  }

  const idPrefix = obj["id-prefix"];
  if (typeof idPrefix !== "string" || !ID_PREFIX_RE.test(idPrefix)) {
    throw new Error(
      `Invalid id-prefix: must be exactly 8 lowercase hex chars${inSrc}`,
    );
  }

  if (obj.format !== 1) {
    throw new Error(
      `Unsupported pack format version: ${obj.format} (expected 1)${inSrc}`,
    );
  }

  if (!Array.isArray(obj.memories) || obj.memories.length === 0) {
    throw new Error(`Pack must have a non-empty memories array${inSrc}`);
  }

  // Parse each memory
  const memories: ParsedMemory[] = [];
  for (let i = 0; i < obj.memories.length; i++) {
    const raw = obj.memories[i];
    const location = `${source ? `${source} ` : ""}memory ${i}`;
    const memory = validateMemoryObject(raw, source, i);

    if (memory.temporal !== undefined) {
      memory.temporal = parseTemporalInput(memory.temporal, "yaml", location);
    }

    memories.push(memory);
  }

  const envelope: PackEnvelope = {
    name: obj.name,
    version: obj.version,
    description:
      typeof obj.description === "string" ? obj.description : undefined,
    idPrefix: idPrefix,
    format: 1,
  };

  return { envelope, memories };
}

/**
 * Validate pack-specific constraints beyond basic parsing.
 *
 * - Every memory must have an id
 * - Every id must start with the envelope's id-prefix
 * - No duplicate ids
 * - No meta.pack on individual memories (injected at install time)
 */
export function validatePackConstraints(
  pack: ParsedPack,
  source?: string,
): string[] {
  const errors: string[] = [];
  const inSrc = source ? ` in ${source}` : "";
  const seenIds = new Set<string>();

  for (let i = 0; i < pack.memories.length; i++) {
    const mem = pack.memories[i];
    if (!mem) continue;

    // Must have an id
    if (!mem.id) {
      errors.push(`Memory ${i}: missing required 'id'${inSrc}`);
      continue;
    }

    // Id must start with id-prefix
    if (!mem.id.startsWith(pack.envelope.idPrefix)) {
      errors.push(
        `Memory ${i}: id '${mem.id}' does not start with id-prefix '${pack.envelope.idPrefix}'${inSrc}`,
      );
    }

    // No duplicate ids
    if (seenIds.has(mem.id)) {
      errors.push(`Memory ${i}: duplicate id '${mem.id}'${inSrc}`);
    }
    seenIds.add(mem.id);

    // No meta.pack on individual memories
    if (mem.meta && typeof mem.meta === "object" && "pack" in mem.meta) {
      errors.push(
        `Memory ${i}: must not include 'meta.pack' (injected at install time)${inSrc}`,
      );
    }
  }

  return errors;
}
