/**
 * API key helpers for the core control plane.
 *
 * Key format: me.{lookupId}.{secret}
 *   - me           fixed prefix
 *   - lookupId     16-char id for the indexed db lookup
 *   - secret       32-char base64url random secret
 *
 * Keys are global per-principal credentials, not space-bound: the same key
 * authenticates into any space the owning principal has been admitted to (the
 * space is selected by the X-Me-Space header, gated by core.build_tree_access).
 *
 * The secret is high-entropy, so we store sha256(secret) and validate by
 * equality in SQL (core.validate_api_key) — no per-request argon2 verify. This
 * matches how session tokens are handled (see packages/accounts/util/hash.ts).
 */

const LOOKUP_ID_LENGTH = 16;
const SECRET_LENGTH = 32;
const LOOKUP_ID_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** Generate a random 16-char lookup id (matches the lookup_id check). */
export function generateLookupId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(LOOKUP_ID_LENGTH));
  let result = "";
  for (const byte of bytes) {
    result += LOOKUP_ID_CHARSET[byte % LOOKUP_ID_CHARSET.length];
  }
  return result;
}

/** Generate a random 32-char base64url secret. */
export function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_LENGTH));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
    .slice(0, SECRET_LENGTH);
}

/** Hash a secret for storage / comparison: sha256, hex-encoded. */
export function hashApiKeySecret(secret: string): string {
  return new Bun.CryptoHasher("sha256").update(secret).digest("hex");
}

/** Assemble a full API key string from its parts. */
export function formatApiKey(lookupId: string, secret: string): string {
  return `me.${lookupId}.${secret}`;
}

/** Parse an API key into its components; null if malformed. */
export function parseApiKey(
  key: string,
): { lookupId: string; secret: string } | null {
  const parts = key.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [prefix, lookupId, secret] = parts;
  if (prefix !== "me") return null;
  if (!lookupId || !/^[A-Za-z0-9_-]{16}$/.test(lookupId)) return null;
  if (!secret || secret.length !== SECRET_LENGTH) return null;
  return { lookupId, secret };
}

/**
 * True if the token is a legacy **space-scoped** api key
 * (`me.<slug>.<lookupId>.<secret>`, the pre-global 4-part format). These no
 * longer authenticate — callers use this to return a clear "recreate your key"
 * error instead of a generic 401. New keys are 3-part (`parseApiKey`).
 */
export function isLegacyApiKey(token: string): boolean {
  const parts = token.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "me" &&
    /^[a-z0-9]{12}$/.test(parts[1] ?? "") &&
    /^[A-Za-z0-9_-]{16}$/.test(parts[2] ?? "") &&
    (parts[3]?.length ?? 0) === SECRET_LENGTH
  );
}
