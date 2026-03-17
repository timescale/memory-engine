import type { SQL } from "bun";

const ENGINE_SCHEMA_RE = /^me_[a-z0-9]{12}$/;
const SLUG_RE = /^[a-z0-9]{12}$/;

export async function discoverEngineSchemas(sql: SQL): Promise<string[]> {
  const rows = await sql`
    select nspname
    from pg_namespace
    where nspname ~ '^me_[a-z0-9]{12}$'
    order by nspname
  `;
  return rows.map((r: { nspname: string }) => r.nspname);
}

export function isValidEngineSchema(name: string): boolean {
  return ENGINE_SCHEMA_RE.test(name);
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

export async function assertEngineSchema(
  sql: SQL,
  schema: string,
): Promise<void> {
  if (!isValidEngineSchema(schema)) {
    throw new Error(
      `Invalid engine schema: "${schema}" — must match me_[a-z0-9]{12}`,
    );
  }

  const [row] = await sql`
    select 1 from pg_namespace where nspname = ${schema}
  `;
  if (!row) {
    throw new Error(`Engine schema "${schema}" does not exist`);
  }
}
