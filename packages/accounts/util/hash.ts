/**
 * Token utilities for session and invitation tokens.
 *
 * Tokens are 256-bit CSPRNG output (base64url-encoded). We store sha256(token)
 * in a unique-indexed column and look up by it directly — no slow-hash verifier
 * is needed because the token's entropy alone defeats offline preimage attacks.
 * See migration 009_session_lookup.sql for the rationale.
 */

/**
 * Generate a random token (32 bytes, base64url encoded).
 */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Compute the lookup hash stored in the session/invitation `token_hash` column.
 * Returns 32 raw bytes suitable for binding directly to a `bytea` parameter.
 */
export function tokenHash(rawToken: string): Buffer {
  return new Bun.CryptoHasher("sha256").update(rawToken).digest();
}
