/**
 * Magic-link invitation token helpers.
 *
 * Token format: inv.{lookupId}.{secret}
 *   - inv          fixed prefix (distinguishes it from an `me.` api key)
 *   - lookupId     16-char id for the indexed db lookup (token_lookup)
 *   - secret       32-char base64url random secret
 *
 * Like api keys, the secret is high-entropy, so we store sha256(secret) as
 * token_hash and validate by equality in SQL (core.redeem_invitation) — no
 * per-request argon2. The raw token is shown to the inviter once at create time
 * (it's never persisted in plaintext) and travels in the invite URL.
 */
import { generateLookupId, generateSecret } from "./api-key";

const SECRET_LENGTH = 32;

/** Mint a fresh invite token; returns the parts + the assembled string. */
export function generateInviteToken(): {
  lookupId: string;
  secret: string;
  token: string;
} {
  const lookupId = generateLookupId();
  const secret = generateSecret();
  return { lookupId, secret, token: `inv.${lookupId}.${secret}` };
}

/** Hash a token secret for storage / comparison: sha256, hex-encoded. */
export function hashInviteToken(secret: string): string {
  return new Bun.CryptoHasher("sha256").update(secret).digest("hex");
}

/** Parse an invite token into its components; null if malformed. */
export function parseInviteToken(
  token: string,
): { lookupId: string; secret: string } | null {
  const parts = token.trim().split(".");
  if (parts.length !== 3) return null;
  const [prefix, lookupId, secret] = parts;
  if (prefix !== "inv") return null;
  if (!lookupId || !/^[A-Za-z0-9_-]{16}$/.test(lookupId)) return null;
  if (!secret || secret.length !== SECRET_LENGTH) return null;
  return { lookupId, secret };
}
