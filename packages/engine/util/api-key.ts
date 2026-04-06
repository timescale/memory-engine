/**
 * API key generation and parsing utilities
 *
 * Key format: me.{engineSlug}.{lookupId}.{secret}
 * Example: me.k8xf2nq4mp7a.Sh00uLs5rmSHHun3.pREy3xfnbCpgUXiaBcD...
 *
 * - me: Fixed prefix for all memory engine keys
 * - engineSlug: 12-char alphanumeric identifier for routing
 * - lookupId: 16-char alphanumeric identifier for database lookup
 * - secret: 32-char random secret, verified against hash
 */

const LOOKUP_ID_LENGTH = 16;
const SECRET_LENGTH = 32;
const LOOKUP_ID_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/**
 * Generate a random lookup ID (16 chars, URL-safe)
 */
export function generateLookupId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(LOOKUP_ID_LENGTH));
  let result = "";
  for (const byte of bytes) {
    result += LOOKUP_ID_CHARSET[byte % LOOKUP_ID_CHARSET.length];
  }
  return result;
}

/**
 * Generate a random secret (32 chars, base64url)
 */
export function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_LENGTH));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
    .slice(0, SECRET_LENGTH);
}

/**
 * Hash a secret for storage using Argon2id
 */
export async function hashSecret(secret: string): Promise<string> {
  return Bun.password.hash(secret, {
    algorithm: "argon2id",
    memoryCost: 19456,
    timeCost: 2,
  });
}

/**
 * Verify a secret against its hash
 */
export async function verifySecret(
  secret: string,
  hash: string,
): Promise<boolean> {
  return Bun.password.verify(secret, hash);
}

/**
 * Format a complete API key from its parts
 */
export function formatApiKey(
  engineSlug: string,
  lookupId: string,
  secret: string,
): string {
  return `me.${engineSlug}.${lookupId}.${secret}`;
}

/**
 * Parse an API key into its components
 * Returns null if the key format is invalid
 */
export function parseApiKey(
  key: string,
): { engineSlug: string; lookupId: string; secret: string } | null {
  const parts = key.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const [prefix, engineSlug, lookupId, secret] = parts;

  // Validate prefix
  if (prefix !== "me") {
    return null;
  }

  // Validate engineSlug format (12 lowercase alphanumeric chars)
  if (!engineSlug || !/^[a-z0-9]{12}$/.test(engineSlug)) {
    return null;
  }

  // Validate lookupId format (16 chars from our charset)
  if (!lookupId || !/^[A-Za-z0-9_-]{16}$/.test(lookupId)) {
    return null;
  }

  // Validate secret (32 chars, base64url)
  if (!secret || secret.length !== SECRET_LENGTH) {
    return null;
  }

  return { engineSlug, lookupId, secret };
}

/**
 * Extract the engine slug from an API key without full parsing
 * Useful for routing before validation
 */
export function extractEngineSlug(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 4 || parts[0] !== "me") {
    return null;
  }
  const slug = parts[1];
  if (!slug || !/^[a-z0-9]{12}$/.test(slug)) {
    return null;
  }
  return slug;
}
