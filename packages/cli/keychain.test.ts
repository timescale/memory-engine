/**
 * Keychain backend tests.
 *
 * The disabled path (ME_NO_KEYCHAIN) is deterministic everywhere. The live
 * round-trip touches the real OS keychain, so it runs only where one is usable:
 * it skips gracefully on Linux without libsecret, in CI, with a locked store, or
 * when ME_NO_KEYCHAIN is set — but on an interactive mac, where a keychain
 * should always work, a failure is treated as a real regression.
 */
import { afterEach, expect, test } from "bun:test";
import {
  keychainAvailable,
  keychainDelete,
  keychainGet,
  keychainSet,
  resetKeychainForTests,
} from "./keychain.ts";

// The ambient value, restored after each test so a dev/CI ME_NO_KEYCHAIN survives.
const AMBIENT_NO_KEYCHAIN = process.env.ME_NO_KEYCHAIN;

afterEach(() => {
  if (AMBIENT_NO_KEYCHAIN === undefined) delete process.env.ME_NO_KEYCHAIN;
  else process.env.ME_NO_KEYCHAIN = AMBIENT_NO_KEYCHAIN;
  resetKeychainForTests();
});

test("ME_NO_KEYCHAIN forces the file fallback", () => {
  process.env.ME_NO_KEYCHAIN = "1";
  resetKeychainForTests();
  expect(keychainAvailable()).toBe(false);
  expect(keychainSet("acct", "secret")).toBe(false);
  expect(keychainGet("acct")).toBeUndefined();
  keychainDelete("acct"); // no-op, must not throw
});

test("keychain round-trip when an OS keychain is usable", () => {
  // Respect an ambient opt-out — nothing to exercise.
  const v = process.env.ME_NO_KEYCHAIN;
  if (v === "1" || v === "true") return;
  resetKeychainForTests();

  const account = `https://kc-test-${crypto.randomUUID()}.example.com`;
  if (!keychainSet(account, "live-secret")) {
    // No usable keychain (Linux without secret-tool, CI, locked store). Skip —
    // but an interactive mac should always have one, so a miss there is a bug.
    expect(process.platform === "darwin" && !process.env.CI).toBe(false);
    return;
  }

  try {
    expect(keychainGet(account)).toBe("live-secret");
    keychainSet(account, "updated-secret"); // -U updates in place
    expect(keychainGet(account)).toBe("updated-secret");
  } finally {
    keychainDelete(account);
  }
  expect(keychainGet(account)).toBeUndefined();
});
