#!/usr/bin/env bun
/**
 * Generate deterministic UUIDv7 memory IDs for a memory pack.
 *
 * Each pack claims a unique 8-char hex prefix in packs/registry.yaml. This
 * script mints sequential IDs of the form
 *
 *     <prefix>-<seq:4hex>-7000-8000-<seq:12hex>
 *
 * which keeps re-installs idempotent and makes IDs visually grep-able.
 *
 * Usage:
 *   ./bun run scripts/pack-uuids.ts <prefix> [count] [start]
 */

const [prefix, countStr = "10", startStr = "1"] = Bun.argv.slice(2);

if (!prefix) {
  console.error("Usage: bun scripts/pack-uuids.ts <prefix> [count] [start]");
  console.error("  prefix: 8 lowercase hex characters (e.g. 019b0003)");
  console.error("  count:  number of IDs to generate (default: 10)");
  console.error("  start:  starting sequence number (default: 1)");
  process.exit(1);
}

if (!/^[0-9a-f]{8}$/.test(prefix)) {
  console.error(
    `Error: prefix must be exactly 8 lowercase hex characters, got "${prefix}"`,
  );
  process.exit(1);
}

const count = parseInt(countStr, 10);
const start = parseInt(startStr, 10);

if (Number.isNaN(count) || count < 1) {
  console.error(`Error: count must be a positive integer, got "${countStr}"`);
  process.exit(1);
}

if (Number.isNaN(start) || start < 1) {
  console.error(`Error: start must be a positive integer, got "${startStr}"`);
  process.exit(1);
}

for (let seq = start; seq < start + count; seq++) {
  const seqHex4 = seq.toString(16).padStart(4, "0");
  const seqHex12 = seq.toString(16).padStart(12, "0");
  console.log(`${prefix}-${seqHex4}-7000-8000-${seqHex12}`);
}
