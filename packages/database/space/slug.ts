const SLUG_RE = /^[a-z0-9]{12}$/;
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const DEFAULT_SPACE_PREFIX = "me_";

// The space-schema prefix is configurable via SPACE_SCHEMA_PREFIX (default
// "me_"), mirroring AUTH_SCHEMA/CORE_SCHEMA. It is read lazily (per call) rather
// than at module load so a test can set the env before the first call despite
// import hoisting (the e2e harness sets "metest_" so its spaces are swept by the
// existing schema reclaimer). Production leaves it unset → "me_".
function spacePrefix(): string {
  const p = process.env.SPACE_SCHEMA_PREFIX ?? DEFAULT_SPACE_PREFIX;
  // Must be a SQL-identifier-safe prefix: lowercase letters/digits/underscore,
  // starting with a letter and ending with "_".
  if (!/^[a-z][a-z0-9_]*_$/.test(p)) {
    throw new Error(
      `Invalid SPACE_SCHEMA_PREFIX: "${p}" — must be lowercase [a-z0-9_], start with a letter, and end with "_"`,
    );
  }
  return p;
}

/** Generate a random 12-char lowercase-alphanumeric space slug. */
export function generateSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let slug = "";
  for (const b of bytes) slug += SLUG_ALPHABET[b % 36];
  return slug;
}

export function isValidSpaceSchema(name: string): boolean {
  return new RegExp(`^${spacePrefix()}[a-z0-9]{12}$`).test(name);
}

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export function slugToSchema(slug: string): string {
  return `${spacePrefix()}${slug}`;
}

export function schemaToSlug(schema: string): string {
  return schema.slice(spacePrefix().length);
}
