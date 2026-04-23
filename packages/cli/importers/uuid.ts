/**
 * Deterministic UUIDv7 derivation for idempotent imports.
 *
 * We need stable UUIDs so that re-importing the same session collides with
 * the existing row in the database and becomes a no-op (or an update).
 * Regular UUIDv7 is random, so we derive a deterministic variant:
 *
 * - 48 bits: Unix ms timestamp (session start time) — keeps chronological sort
 * - 4 bits:  version = 7
 * - 12 bits: rand_a ← SHA-256(tool + ':' + sessionId), bits 0..11
 * - 2 bits:  variant = 10
 * - 62 bits: rand_b ← SHA-256(tool + ':' + sessionId), bits 12..73
 *
 * The result passes the `uuid_extract_version(id) = 7` check in the engine's
 * memory schema, sorts by session start, and is stable across re-imports.
 */
import { createHash } from "node:crypto";
import type { SourceTool } from "./types.ts";

/**
 * Compute a deterministic UUIDv7 from `(tool, sessionId, startedAtMs)`.
 *
 * Given the same inputs, always returns the same UUID. Different inputs
 * produce different UUIDs (cryptographically, with SHA-256).
 */
export function deterministicUuidV7(
  tool: SourceTool,
  sessionId: string,
  startedAtMs: number,
): string {
  // 16 bytes = 128 bits
  const bytes = new Uint8Array(16);

  // Bytes 0..5 (48 bits): timestamp in ms, big-endian.
  // Math.floor defensively clamps fractional inputs.
  const ts = Math.max(0, Math.floor(startedAtMs));
  // High 16 bits of the top 32
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  // Low 32 bits
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;

  // SHA-256 of "tool:sessionId" gives us 32 bytes of deterministic pseudo-random.
  // We need 74 bits (12 + 62). 10 bytes (80 bits) is more than enough.
  const digest = createHash("sha256")
    .update(`${tool}:${sessionId}`, "utf8")
    .digest();

  // Bytes 6..7 (16 bits): version (4 bits) + rand_a (12 bits)
  // Upper 4 bits of byte 6 = 0x7, lower 4 bits + byte 7 = 12 rand_a bits.
  const randA = ((digest[0] ?? 0) << 8) | (digest[1] ?? 0);
  bytes[6] = 0x70 | ((randA >> 8) & 0x0f);
  bytes[7] = randA & 0xff;

  // Byte 8: variant (2 bits = 0b10) + top 6 bits of rand_b.
  // Bytes 9..15: remaining 56 bits of rand_b (from digest[3..10)).
  bytes[8] = 0x80 | ((digest[2] ?? 0) & 0x3f);
  for (let i = 0; i < 7; i++) {
    bytes[9 + i] = digest[3 + i] ?? 0;
  }

  return bytesToUuid(bytes);
}

/**
 * Format 16 bytes as a canonical UUID string.
 */
function bytesToUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) {
    hex.push((bytes[i] ?? 0).toString(16).padStart(2, "0"));
  }
  return (
    `${hex.slice(0, 4).join("")}-` +
    `${hex.slice(4, 6).join("")}-` +
    `${hex.slice(6, 8).join("")}-` +
    `${hex.slice(8, 10).join("")}-` +
    `${hex.slice(10, 16).join("")}`
  );
}
