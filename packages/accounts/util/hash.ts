/**
 * Token hashing utilities using Argon2id
 *
 * Used for session tokens and invitation tokens - we only need to verify,
 * not retrieve the original value.
 */

/**
 * Hash a token for storage using Argon2id
 */
export async function hashToken(token: string): Promise<string> {
  return Bun.password.hash(token, {
    algorithm: "argon2id",
    memoryCost: 19456,
    timeCost: 2,
  });
}

/**
 * Verify a token against its hash
 */
export async function verifyToken(
  token: string,
  hash: string,
): Promise<boolean> {
  return Bun.password.verify(token, hash);
}

/**
 * Generate a random token (32 bytes, base64url encoded)
 */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}
