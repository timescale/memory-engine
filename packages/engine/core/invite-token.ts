/**
 * Magic-link invitation token.
 *
 * Token format: inv.{secret} — an opaque, high-entropy random string. Unlike an
 * api key, the token is stored **raw** (not hashed): an invite link is a scoped,
 * revocable, expirable, max-uses-capped bearer link that the admin is expected
 * to be able to re-copy from the management UI — not a show-once secret. It
 * travels in the invite URL (`<server>/invite/<token>`) and is matched by
 * equality on redemption.
 */
import { generateSecret } from "./api-key";

/** Mint a fresh opaque invite token. */
export function generateInviteToken(): string {
  return `inv.${generateSecret()}`;
}
