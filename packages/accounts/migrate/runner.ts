import { type SQL, semver } from "bun";
import migration001 from "./migrations/001_create_schema.sql" with {
  type: "text",
};
import { type AccountsConfig, resolveConfig, template } from "./template";

interface Migration {
  name: string;
  sql: string;
}

const migrations: Migration[] = [
  { name: "001_create_schema", sql: migration001 },
];

export interface MigrateResult {
  schema: string;
  status: "ok" | "skipped" | "error";
  applied: string[];
  error?: Error;
}

const MAX_LOCK_RETRIES = 5;
const BASE_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function migrate(
  sql: SQL,
  config?: AccountsConfig,
  appVersion = "0.0.0",
): Promise<MigrateResult> {
  const resolved = resolveConfig(config);
  const { schema } = resolved;

  return await sql.begin(async (tx) => {
    // Acquire advisory lock with retry
    const [{ lock_id }] =
      await tx`select hashtext(${schema})::bigint as lock_id`;

    let acquired = false;
    for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
      const [result] =
        await tx`select pg_try_advisory_xact_lock(${lock_id}) as acquired`;
      if (result.acquired) {
        acquired = true;
        break;
      }
      if (attempt < MAX_LOCK_RETRIES - 1) {
        await sleep(BASE_DELAY_MS * 2 ** attempt);
      }
    }

    if (!acquired) {
      return { schema, status: "skipped" as const, applied: [] };
    }

    // Check if schema exists (first migration creates it)
    const [{ schema_exists }] = await tx`
      select exists (
        select 1 from information_schema.schemata where schema_name = ${schema}
      ) as schema_exists
    `;

    // Check version if schema exists
    if (schema_exists) {
      const [{ table_exists }] = await tx`
        select exists (
          select 1 from information_schema.tables
          where table_schema = ${schema} and table_name = 'version'
        ) as table_exists
      `;

      if (table_exists) {
        const [{ version: dbVersion }] = await tx.unsafe(
          `select version from ${schema}.version`,
        );

        const cmp = semver.order(appVersion, dbVersion);
        if (cmp < 0) {
          throw new Error(
            `App version (${appVersion}) is older than database version (${dbVersion}). ` +
              "Please upgrade the application.",
          );
        }
      }
    }

    // Run migrations
    const sorted = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
    const applied: string[] = [];

    for (const migration of sorted) {
      // Check if migration table exists before querying it
      if (schema_exists) {
        const [{ table_exists }] = await tx`
          select exists (
            select 1 from information_schema.tables
            where table_schema = ${schema} and table_name = 'migration'
          ) as table_exists
        `;

        if (table_exists) {
          const [existing] = await tx.unsafe(
            `select 1 from ${schema}.migration where name = $1`,
            [migration.name],
          );

          if (existing) {
            continue;
          }
        }
      }

      const renderedSql = template(migration.sql, resolved);
      await tx.unsafe(renderedSql);
      await tx.unsafe(
        `insert into ${schema}.migration (name, applied_at_version) values ($1, $2)`,
        [migration.name, appVersion],
      );
      applied.push(migration.name);
    }

    // Update version if we applied migrations and app version is newer
    if (applied.length > 0 || schema_exists) {
      const [{ version: currentVersion }] = await tx.unsafe(
        `select version from ${schema}.version`,
      );
      if (semver.order(appVersion, currentVersion) > 0) {
        await tx.unsafe(
          `update ${schema}.version set version = $1, at = now()`,
          [appVersion],
        );
      }
    }

    return { schema, status: "ok" as const, applied };
  });
}

export async function dryRun(
  sql: SQL,
  config?: AccountsConfig,
): Promise<{ pending: string[]; applied: string[] }> {
  const { schema } = resolveConfig(config);
  const sorted = [...migrations].sort((a, b) => a.name.localeCompare(b.name));

  // Check if migration table exists
  const [{ exists }] = await sql`
    select exists (
      select 1 from information_schema.tables
      where table_schema = ${schema} and table_name = 'migration'
    ) as exists
  `;

  if (!exists) {
    return {
      pending: sorted.map((m) => m.name),
      applied: [],
    };
  }

  const rows = await sql.unsafe(
    `select name from ${schema}.migration order by name`,
  );
  const appliedSet = new Set(rows.map((r: { name: string }) => r.name));
  const applied = sorted
    .filter((m) => appliedSet.has(m.name))
    .map((m) => m.name);
  const pending = sorted
    .filter((m) => !appliedSet.has(m.name))
    .map((m) => m.name);

  return { pending, applied };
}

export async function getVersion(
  sql: SQL,
  config?: AccountsConfig,
): Promise<string> {
  const { schema } = resolveConfig(config);
  const [row] = await sql.unsafe(`select version from ${schema}.version`);
  return row.version;
}

export function getMigrations(): ReadonlyArray<{ name: string }> {
  return [...migrations]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name }) => ({ name }));
}
