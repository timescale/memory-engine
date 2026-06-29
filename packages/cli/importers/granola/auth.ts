/**
 * Granola local-credential reader.
 *
 * Granola (an Electron app) persists its WorkOS session tokens locally, but
 * encrypted with Electron's `safeStorage`. There is no public credential file
 * to read — instead we reproduce the same two-layer key derivation the app
 * uses, entirely from local material:
 *
 *   1. The OS keychain holds a base64 password under the generic-password
 *      service `"Granola Safe Storage"` (Chromium's `os_crypt` convention).
 *   2. That password, run through PBKDF2-HMAC-SHA1 (salt `saltysalt`, 1003
 *      iterations, 16-byte key), is an AES-128-CBC key (IV = 16 spaces) that
 *      decrypts `storage.dek` — yielding a base64 32-byte **data encryption
 *      key** (DEK).
 *   3. The DEK decrypts the app's `*.enc` blobs as AES-256-GCM with the layout
 *      `iv(12) | ciphertext | tag(16)`.
 *
 * `supabase.json.enc` decrypts to `{ workos_tokens: "<json string>" }`, whose
 * inner JSON carries the `access_token` / `refresh_token`. The access token is
 * short-lived (~hours), so callers refresh it through the Granola API before
 * use (see `client.ts`).
 *
 * This is macOS-only for now: the keychain step shells out to `security`. On
 * any other platform — or when Granola isn't installed / the user isn't logged
 * in — `readGranolaTokens` throws a `GranolaAuthError` with an actionable
 * message instead of a raw crypto failure.
 */

import { type CipherKey, createDecipheriv, pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default Granola application-support directory (macOS). */
export function defaultGranolaDir(): string {
  return join(homedir(), "Library", "Application Support", "Granola");
}

/** Keychain generic-password service that holds the safeStorage password. */
const KEYCHAIN_SERVICE = "Granola Safe Storage";
/** Chromium os_crypt PBKDF2 parameters. */
const PBKDF2_SALT = "saltysalt";
const PBKDF2_ITERATIONS = 1003;
const PBKDF2_KEY_LEN = 16;
/** safeStorage CBC IV is 16 spaces; the ciphertext carries a 3-byte `v10` tag. */
const CBC_IV = Buffer.alloc(16, 0x20);
const SAFE_STORAGE_PREFIX_LEN = 3;
/** GCM layout used by Granola's `*.enc` blobs. */
const GCM_IV_LEN = 12;
const GCM_TAG_LEN = 16;

/** The WorkOS token bundle Granola persists (only the fields we use). */
export interface GranolaTokens {
  access_token: string;
  refresh_token: string;
  /** Seconds-from-issue lifetime, when present. */
  expires_in?: number;
}

/** A user-actionable failure to read Granola's local credentials. */
export class GranolaAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GranolaAuthError";
  }
}

/** Minimal shape of a process runner, injectable for tests. */
export type CommandRunner = (
  cmd: string[],
) => { exitCode: number; stdout: string } | null;

/** Default runner: shells out via Bun.spawnSync, returns null on spawn error. */
const defaultRunner: CommandRunner = (cmd) => {
  try {
    const r = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
    return { exitCode: r.exitCode ?? 1, stdout: r.stdout.toString() };
  } catch {
    return null;
  }
};

/** Read the base64 safeStorage password from the macOS login keychain. */
function readKeychainPassword(run: CommandRunner): string {
  if (process.platform !== "darwin") {
    throw new GranolaAuthError(
      "Granola import currently supports macOS only (it reads Granola's " +
        "credentials from the login keychain).",
    );
  }
  const r = run([
    "security",
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (!r || r.exitCode !== 0 || r.stdout.trim().length === 0) {
    throw new GranolaAuthError(
      `Could not read the Granola key from the login keychain (service ` +
        `"${KEYCHAIN_SERVICE}"). Is the Granola desktop app installed and ` +
        `signed in on this machine?`,
    );
  }
  return r.stdout.trim();
}

/** Derive the 32-byte AES-256-GCM data encryption key from `storage.dek`. */
function readDataEncryptionKey(dir: string, run: CommandRunner): Buffer {
  const password = readKeychainPassword(run);
  const cbcKey = pbkdf2Sync(
    password,
    PBKDF2_SALT,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LEN,
    "sha1",
  );

  let dekBlob: Buffer;
  try {
    dekBlob = readFileSync(join(dir, "storage.dek"));
  } catch {
    throw new GranolaAuthError(
      `Granola's storage.dek key file was not found under ${dir}. Is Granola ` +
        `installed and signed in on this machine?`,
    );
  }

  let dekBase64: string;
  try {
    const decipher = createDecipheriv("aes-128-cbc", cbcKey, CBC_IV);
    const plaintext = Buffer.concat([
      decipher.update(dekBlob.subarray(SAFE_STORAGE_PREFIX_LEN)),
      decipher.final(),
    ]);
    dekBase64 = plaintext.toString("utf8");
  } catch {
    throw new GranolaAuthError(
      "Failed to decrypt Granola's data key (storage.dek). The keychain key " +
        "may be stale — try opening the Granola app, then re-run.",
    );
  }

  const dek = Buffer.from(dekBase64, "base64");
  if (dek.length !== 32) {
    throw new GranolaAuthError(
      `Granola's decrypted data key has an unexpected length (${dek.length} ` +
        `bytes; expected 32). Granola's storage format may have changed.`,
    );
  }
  return dek;
}

/** AES-256-GCM-decrypt one of Granola's `*.enc` blobs with the DEK. */
function decryptEnc(blob: Buffer, key: CipherKey): string {
  const iv = blob.subarray(0, GCM_IV_LEN);
  const tag = blob.subarray(blob.length - GCM_TAG_LEN);
  const ciphertext = blob.subarray(GCM_IV_LEN, blob.length - GCM_TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Read Granola's locally-stored WorkOS tokens, decrypting the on-disk
 * `supabase.json.enc` blob. Throws `GranolaAuthError` with an actionable
 * message when Granola isn't installed / signed in or the format has changed.
 *
 * `dir` defaults to the standard application-support path; `run` is injectable
 * so tests can stub the keychain lookup.
 */
export function readGranolaTokens(
  dir: string = defaultGranolaDir(),
  run: CommandRunner = defaultRunner,
): GranolaTokens {
  const dek = readDataEncryptionKey(dir, run);

  let blob: Buffer;
  try {
    blob = readFileSync(join(dir, "supabase.json.enc"));
  } catch {
    throw new GranolaAuthError(
      `Granola's supabase.json.enc was not found under ${dir}. Sign in to the ` +
        `Granola desktop app, then re-run.`,
    );
  }

  let outer: { workos_tokens?: string };
  try {
    outer = JSON.parse(decryptEnc(blob, dek)) as { workos_tokens?: string };
  } catch {
    throw new GranolaAuthError(
      "Failed to decrypt Granola's session file (supabase.json.enc). Try " +
        "opening the Granola app to refresh its local state, then re-run.",
    );
  }

  if (!outer.workos_tokens) {
    throw new GranolaAuthError(
      "Granola's session file did not contain WorkOS tokens. Sign in to the " +
        "Granola desktop app, then re-run.",
    );
  }

  let tokens: GranolaTokens;
  try {
    tokens = JSON.parse(outer.workos_tokens) as GranolaTokens;
  } catch {
    throw new GranolaAuthError(
      "Granola's WorkOS token bundle was not valid JSON. Granola's storage " +
        "format may have changed.",
    );
  }

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new GranolaAuthError(
      "Granola's session is missing an access or refresh token. Sign in to " +
        "the Granola desktop app, then re-run.",
    );
  }
  return tokens;
}
