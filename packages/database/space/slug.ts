const SPACE_SCHEMA_RE = /^me_[a-z0-9]{12}$/;
const SLUG_RE = /^[a-z0-9]{12}$/;

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
