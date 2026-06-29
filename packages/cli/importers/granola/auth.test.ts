/**
 * Tests for the Granola local-credential reader. We don't have Granola's real
 * keychain entry under test, so we reproduce its two-layer scheme in reverse to
 * synthesize a `storage.dek` + `supabase.json.enc` pair from a known password,
 * then assert `readGranolaTokens` recovers the tokens — and surfaces actionable
 * `GranolaAuthError`s when material is missing or corrupt.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandRunner,
  GranolaAuthError,
  readGranolaTokens,
} from "./auth.ts";

const PASSWORD = "dGVzdC1wYXNzd29yZC0xMjM0"; // arbitrary base64-looking string
const CBC_IV = Buffer.alloc(16, 0x20);

/** Encrypt a base64 DEK into a `storage.dek` blob (CBC, v10 prefix). */
function makeStorageDek(password: string, dek: Buffer): Buffer {
  const cbcKey = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", cbcKey, CBC_IV);
  const body = Buffer.concat([
    cipher.update(dek.toString("base64"), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from("v10"), body]);
}

/** Encrypt a plaintext into a Granola `.enc` blob (GCM: iv|ct|tag). */
function makeEnc(dek: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

let dir: string;

/** A runner that returns the known password for the keychain lookup. */
const okRunner: CommandRunner = () => ({
  exitCode: 0,
  stdout: `${PASSWORD}\n`,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "granola-auth-"));
  const dek = randomBytes(32);
  writeFileSync(join(dir, "storage.dek"), makeStorageDek(PASSWORD, dek));
  const tokens = {
    access_token: "access-abc",
    refresh_token: "refresh-xyz",
    expires_in: 3600,
  };
  const supabase = { workos_tokens: JSON.stringify(tokens) };
  writeFileSync(
    join(dir, "supabase.json.enc"),
    makeEnc(dek, JSON.stringify(supabase)),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readGranolaTokens", () => {
  test.skipIf(process.platform !== "darwin")(
    "decrypts the DEK chain and recovers tokens",
    () => {
      const tokens = readGranolaTokens(dir, okRunner);
      expect(tokens.access_token).toBe("access-abc");
      expect(tokens.refresh_token).toBe("refresh-xyz");
      expect(tokens.expires_in).toBe(3600);
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "throws GranolaAuthError when the keychain lookup fails",
    () => {
      const failRunner: CommandRunner = () => ({ exitCode: 1, stdout: "" });
      expect(() => readGranolaTokens(dir, failRunner)).toThrow(
        GranolaAuthError,
      );
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "throws GranolaAuthError when storage.dek is missing",
    () => {
      rmSync(join(dir, "storage.dek"));
      expect(() => readGranolaTokens(dir, okRunner)).toThrow(GranolaAuthError);
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "throws GranolaAuthError when the password is wrong",
    () => {
      const wrongPw: CommandRunner = () => ({
        exitCode: 0,
        stdout: "totally-different-password\n",
      });
      expect(() => readGranolaTokens(dir, wrongPw)).toThrow(GranolaAuthError);
    },
  );

  test.skipIf(process.platform === "darwin")(
    "throws on non-macOS platforms",
    () => {
      expect(() => readGranolaTokens(dir, okRunner)).toThrow(GranolaAuthError);
    },
  );
});
