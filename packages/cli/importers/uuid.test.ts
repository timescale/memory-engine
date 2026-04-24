/**
 * Tests for deterministic per-message UUIDv7 derivation.
 */
import { describe, expect, test } from "bun:test";
import { deterministicMessageUuidV7 } from "./uuid.ts";

const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("deterministicMessageUuidV7", () => {
  test("produces a valid UUIDv7", () => {
    const id = deterministicMessageUuidV7(
      "claude",
      "session-123",
      "msg-1",
      1_700_000_000_000,
    );
    expect(id).toMatch(UUIDV7_RE);
  });

  test("is deterministic for the same inputs", () => {
    const a = deterministicMessageUuidV7(
      "claude",
      "abc",
      "m1",
      1_700_000_000_000,
    );
    const b = deterministicMessageUuidV7(
      "claude",
      "abc",
      "m1",
      1_700_000_000_000,
    );
    expect(a).toBe(b);
  });

  test("changes when tool changes", () => {
    const a = deterministicMessageUuidV7(
      "claude",
      "abc",
      "m1",
      1_700_000_000_000,
    );
    const b = deterministicMessageUuidV7(
      "codex",
      "abc",
      "m1",
      1_700_000_000_000,
    );
    expect(a).not.toBe(b);
  });

  test("changes when sessionId changes", () => {
    const a = deterministicMessageUuidV7(
      "claude",
      "abc",
      "m1",
      1_700_000_000_000,
    );
    const b = deterministicMessageUuidV7(
      "claude",
      "xyz",
      "m1",
      1_700_000_000_000,
    );
    expect(a).not.toBe(b);
  });

  test("changes when messageId changes", () => {
    const a = deterministicMessageUuidV7(
      "claude",
      "abc",
      "m1",
      1_700_000_000_000,
    );
    const b = deterministicMessageUuidV7(
      "claude",
      "abc",
      "m2",
      1_700_000_000_000,
    );
    expect(a).not.toBe(b);
  });

  test("encodes the timestamp in the leading 48 bits", () => {
    const ts = 1_700_000_000_000;
    const id = deterministicMessageUuidV7("claude", "abc", "m1", ts);
    // Strip dashes, take first 12 hex chars = 48 bits = 6 bytes.
    const tsHex = id.replace(/-/g, "").slice(0, 12);
    const decoded = Number.parseInt(tsHex, 16);
    expect(decoded).toBe(ts);
  });

  test("version nibble is 7 and variant bits are 10", () => {
    const id = deterministicMessageUuidV7(
      "opencode",
      "ses_123",
      "msg_1",
      1_700_000_000_000,
    );
    // Position 14 (after first two dashes) = version nibble.
    expect(id.charAt(14)).toBe("7");
    // Position 19 = variant high nibble; top 2 bits must be 10 → hex 8/9/a/b.
    expect(["8", "9", "a", "b"]).toContain(id.charAt(19));
  });
});
