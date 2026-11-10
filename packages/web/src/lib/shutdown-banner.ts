const INTERNAL_EMAIL_DOMAIN = "tigerdata.com";

/**
 * Return the public-hosting wind-down notice when the signed-in identity has an
 * external email address, or null for @tigerdata.com and non-email identities.
 */
export function shutdownBannerMessage(
  email: string | null | undefined,
): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === trimmed.length - 1) return null;
  const domain = trimmed.slice(atIndex + 1).toLowerCase();
  if (domain === INTERNAL_EMAIL_DOMAIN) return null;
  return `Memory Engine is shutting down public hosting. Access for ${trimmed} will end on November 30, 2026. Export any personal memories you want to keep before then.`;
}
