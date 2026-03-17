/**
 * API key generation and parsing utilities
 *
 * Key format: {schema}.{lookupId}.{secret}
 * Example: me_k8xf2nq4mp7.Sh00uLs5rmSHHun3.pREy3xf-nbCpgUXi...
 *
 * - schema: The engine schema name (e.g., me_k8xf2nq4mp7) — enables self-routing
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
  // Use base64url encoding (URL-safe, no padding)
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
  schema: string,
  lookupId: string,
  secret: string,
): string {
  return `${schema}.${lookupId}.${secret}`;
}

/**
 * Parse an API key into its components
 * Returns null if the key format is invalid
 */
export function parseApiKey(
  key: string,
): { schema: string; lookupId: string; secret: string } | null {
  const parts = key.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [schema, lookupId, secret] = parts;

  // Validate schema format (me_ prefix + 12 alphanumeric chars)
  if (!schema || !/^me_[a-z0-9]{12}$/.test(schema)) {
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

  return { schema, lookupId, secret };
}

/**
 * Extract the schema (engine ID) from an API key without full validation
 * Useful for routing before full validation
 */
export function extractSchemaFromKey(key: string): string | null {
  const dotIndex = key.indexOf(".");
  if (dotIndex === -1) {
    return null;
  }

  const schema = key.slice(0, dotIndex);
  if (!/^me_[a-z0-9]{12}$/.test(schema)) {
    return null;
  }

  return schema;
}
