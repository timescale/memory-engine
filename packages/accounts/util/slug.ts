/**
 * Slug generation
 *
 * Generates a 12-character alphanumeric slug (a-z, 0-9) for org and engine identification.
 */

const SLUG_LENGTH = 12;
const SLUG_CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generate a random slug (12 lowercase alphanumeric chars)
 */
export function generateSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SLUG_LENGTH));
  let result = "";
  for (const byte of bytes) {
    result += SLUG_CHARSET[byte % SLUG_CHARSET.length];
  }
  return result;
}
