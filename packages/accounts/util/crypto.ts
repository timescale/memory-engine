/**
 * Envelope encryption for OAuth tokens
 *
 * Uses a master key (from environment) to encrypt data keys stored in the DB.
 * Data keys encrypt the actual OAuth tokens. This allows key rotation without
 * re-encrypting all tokens at once.
 *
 * Algorithm: AES-256-GCM
 * Ciphertext format: {iv}:{ciphertext}:{authTag} (all base64)
 */

import type { SQL } from "bun";
import type { AccountsCrypto } from "../types";

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const TAG_LENGTH = 128;

interface EncryptionKeyRow {
  id: number;
  key_ciphertext: Buffer;
  active: boolean;
  created_at: Date;
}

/**
 * Import a raw key for AES-GCM operations
 */
async function importKey(keyBytes: Buffer | Uint8Array): Promise<CryptoKey> {
  // Copy into a fresh ArrayBuffer for Web Crypto API compatibility
  // (Buffer's underlying buffer may be SharedArrayBuffer which Web Crypto rejects)
  const bytes = new Uint8Array(keyBytes.length);
  bytes.set(keyBytes);

  return crypto.subtle.importKey(
    "raw",
    bytes,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt plaintext using AES-256-GCM
 */
async function encryptAES(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    key,
    data,
  );

  // Split ciphertext and auth tag (last 16 bytes)
  const ciphertextBytes = new Uint8Array(ciphertext.slice(0, -16));
  const authTag = new Uint8Array(ciphertext.slice(-16));

  const ivB64 = btoa(String.fromCharCode(...iv));
  const ciphertextB64 = btoa(String.fromCharCode(...ciphertextBytes));
  const tagB64 = btoa(String.fromCharCode(...authTag));

  return `${ivB64}:${ciphertextB64}:${tagB64}`;
}

/**
 * Decrypt ciphertext using AES-256-GCM
 */
async function decryptAES(key: CryptoKey, ciphertext: string): Promise<string> {
  const [ivB64, ciphertextB64, tagB64] = ciphertext.split(":");
  if (!ivB64 || !ciphertextB64 || !tagB64) {
    throw new Error("Invalid ciphertext format");
  }

  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const ciphertextBytes = Uint8Array.from(atob(ciphertextB64), (c) =>
    c.charCodeAt(0),
  );
  const authTag = Uint8Array.from(atob(tagB64), (c) => c.charCodeAt(0));

  // Combine ciphertext and auth tag for Web Crypto API
  const combined = new Uint8Array(ciphertextBytes.length + authTag.length);
  combined.set(ciphertextBytes);
  combined.set(authTag, ciphertextBytes.length);

  const plaintext = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    key,
    combined,
  );

  return new TextDecoder().decode(plaintext);
}

/**
 * Create an AccountsCrypto instance for envelope encryption
 */
export function createAccountsCrypto(
  masterKey: Buffer,
  ctx: { sql: SQL; schema: string },
): AccountsCrypto {
  // Cache for decrypted data keys
  const keyCache = new Map<number, CryptoKey>();
  let masterCryptoKey: CryptoKey | null = null;

  async function getMasterKey(): Promise<CryptoKey> {
    if (!masterCryptoKey) {
      masterCryptoKey = await importKey(masterKey);
    }
    return masterCryptoKey;
  }

  async function getDataKey(keyId: number): Promise<CryptoKey> {
    const cached = keyCache.get(keyId);
    if (cached) {
      return cached;
    }

    const { sql, schema } = ctx;
    const [row] = await sql<EncryptionKeyRow[]>`
      select id, key_ciphertext, active, created_at
      from ${sql.unsafe(schema)}.encryption_key
      where id = ${keyId}
    `;

    if (!row) {
      throw new Error(`Encryption key ${keyId} not found`);
    }

    const master = await getMasterKey();
    const dataKeyBytes = await decryptAES(
      master,
      row.key_ciphertext.toString("utf-8"),
    );
    const dataKey = await importKey(Buffer.from(dataKeyBytes, "base64"));

    keyCache.set(keyId, dataKey);
    return dataKey;
  }

  async function getActiveKeyId(): Promise<number> {
    const { sql, schema } = ctx;
    const [row] = await sql<{ id: number }[]>`
      select id from ${sql.unsafe(schema)}.encryption_key
      where active = true
    `;

    if (!row) {
      throw new Error("No active encryption key");
    }

    return row.id;
  }

  return {
    async encrypt(
      plaintext: string,
    ): Promise<{ ciphertext: string; keyId: number }> {
      const keyId = await getActiveKeyId();
      const dataKey = await getDataKey(keyId);
      const ciphertext = await encryptAES(dataKey, plaintext);
      return { ciphertext, keyId };
    },

    async decrypt(ciphertext: string, keyId: number): Promise<string> {
      const dataKey = await getDataKey(keyId);
      return decryptAES(dataKey, ciphertext);
    },

    async createDataKey(): Promise<number> {
      const { sql, schema } = ctx;

      // Generate a random 256-bit key
      const dataKeyBytes = crypto.getRandomValues(new Uint8Array(32));
      const dataKeyB64 = btoa(String.fromCharCode(...dataKeyBytes));

      // Encrypt with master key
      const master = await getMasterKey();
      const keyCiphertext = await encryptAES(master, dataKeyB64);

      const [row] = await sql<{ id: number }[]>`
        insert into ${sql.unsafe(schema)}.encryption_key (key_ciphertext, active)
        values (${keyCiphertext}::bytea, false)
        returning id
      `;

      if (!row) {
        throw new Error("Failed to create encryption key");
      }

      return row.id;
    },

    async activateDataKey(keyId: number): Promise<void> {
      const { sql, schema } = ctx;

      // Deactivate all keys, then activate the specified one
      await sql`
        update ${sql.unsafe(schema)}.encryption_key
        set active = false
        where active = true
      `;

      const result = await sql`
        update ${sql.unsafe(schema)}.encryption_key
        set active = true
        where id = ${keyId}
      `;

      if (result.count === 0) {
        throw new Error(`Encryption key ${keyId} not found`);
      }

      // Clear cache since active key changed
      keyCache.clear();
    },
  };
}
