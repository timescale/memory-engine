const SPACE_SCHEMA_RE = /^me_[a-z0-9]{12}$/;
const SLUG_RE = /^[a-z0-9]{12}$/;
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Generate a random 12-char lowercase-alphanumeric space slug. */
export function generateSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let slug = "";
  for (const b of bytes) slug += SLUG_ALPHABET[b % 36];
  return slug;
}

export function isValidSpaceSchema(name: string): boolean {
  return SPACE_SCHEMA_RE.test(name);
}

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export function slugToSchema(slug: string): string {
  return `me_${slug}`;
}

export function schemaToSlug(schema: string): string {
  return schema.slice(3);
}
