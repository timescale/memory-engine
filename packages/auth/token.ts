/**
 * Token + device-code helpers for the auth layer.
 *
 * Session tokens are 256-bit CSPRNG values; we store sha256(token) (bytea) and
 * look up by hash — entropy alone defeats offline preimage attacks, so a fast
 * hash is sufficient and a DB read never yields usable bearer tokens.
 */

const SESSION_TOKEN_BYTES = 32;
const DEVICE_CODE_BYTES = 32;
const OAUTH_STATE_BYTES = 16;

/** User code: 8 chars, excluding ambiguous 0/O/1/I/L, shown as XXXX-XXXX. */
const USER_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Device authorization lifetime (15 minutes), in seconds. */
export const DEVICE_CODE_EXPIRY_SECONDS = 15 * 60;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function randomBase64url(byteLength: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** Generate a random 256-bit session token (base64url). */
export function generateSessionToken(): string {
  return randomBase64url(SESSION_TOKEN_BYTES);
}

/** sha256(token) as raw bytes, for the `token_hash` bytea column. */
export function hashSessionToken(token: string): Buffer {
  return new Bun.CryptoHasher("sha256").update(token).digest();
}

/** Device flow: the CLI polling secret (base64url, 32 bytes). */
export function generateDeviceCode(): string {
  return randomBase64url(DEVICE_CODE_BYTES);
}

/** Device flow: the OAuth `state` (CSRF binding, base64url, 16 bytes). */
export function generateOAuthState(): string {
  return randomBase64url(OAUTH_STATE_BYTES);
}

/** Device flow: the human-entered code, formatted XXXX-XXXX. */
export function generateUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = "";
  for (const b of bytes) code += USER_CODE_CHARS[b % USER_CODE_CHARS.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Normalize user-entered codes (uppercase, strip hyphens, re-hyphenate). */
export function normalizeUserCode(input: string): string {
  const c = input.toUpperCase().replace(/-/g, "");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
