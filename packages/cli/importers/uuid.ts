/**
 * UUIDv7 minting for importers.
 *
 * Importers key idempotency on `(tree, name)` (a source-coordinate name like
 * `msg_<messageId>` or a commit `<sha>`), not the id — so the id no longer
 * needs to be derived from the source. It only needs to:
 *
 * - pass the engine's `uuid_extract_version(id) = 7` check, and
 * - carry the record's timestamp in the 48-bit prefix so memories sort
 *   chronologically by id (the import watermark orders newest-first by id).
 *
 * So we mint a v7 with the record timestamp in the prefix and a random tail.
 * A re-import mints a *different* id for the same record, but the server dedups
 * on `(tree, name)` and keeps the existing row's id, so identity stays stable.
 */

/**
 * Mint a UUIDv7 whose 48-bit timestamp prefix is `timestampMs` and whose low
 * bits are random. Two calls with the same timestamp return different ids that
 * share a prefix (so they sort together, by time).
 */
export function uuidv7At(timestampMs: number): string {
  // 16 random bytes; we overwrite the timestamp prefix and the version/variant.
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  // Bytes 0..5 (48 bits): timestamp in ms, big-endian.
  const ts = Math.max(0, Math.floor(timestampMs));
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;

  // Byte 6: version (4 bits = 0x7) over the random nibble.
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  // Byte 8: variant (2 bits = 0b10) over the random bits.
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);

  return bytesToUuid(bytes);
}

/** Format 16 bytes as a canonical UUID string. */
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
