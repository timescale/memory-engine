/**
 * Tests for timestamp-prefixed UUIDv7 minting.
 */
import { describe, expect, test } from "bun:test";
import { uuidv7At } from "./uuid.ts";

const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("uuidv7At", () => {
  test("produces a valid UUIDv7", () => {
    expect(uuidv7At(1_700_000_000_000)).toMatch(UUIDV7_RE);
  });

  test("encodes the timestamp in the leading 48 bits", () => {
    const ts = 1_700_000_000_000;
    const tsHex = uuidv7At(ts).replace(/-/g, "").slice(0, 12);
    expect(Number.parseInt(tsHex, 16)).toBe(ts);
  });

  test("version nibble is 7 and variant bits are 10", () => {
    const id = uuidv7At(1_700_000_000_000);
    expect(id.charAt(14)).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(id.charAt(19));
  });

  test("is random: two calls at the same timestamp differ but share the prefix", () => {
    const ts = 1_700_000_000_000;
    const a = uuidv7At(ts);
    const b = uuidv7At(ts);
    expect(a).not.toBe(b);
    // Same 48-bit timestamp prefix → they sort together by time.
    expect(a.replace(/-/g, "").slice(0, 12)).toBe(
      b.replace(/-/g, "").slice(0, 12),
    );
  });

  test("later timestamps sort after earlier ones (lexicographic by id)", () => {
    const earlier = uuidv7At(1_700_000_000_000);
    const later = uuidv7At(1_700_000_001_000);
    expect(later > earlier).toBe(true);
  });
});
