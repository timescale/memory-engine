import { type SQL, semver } from "bun";
import { assertEngineSchema } from "./discover";
import migration001 from "./migrations/001_updated_at.sql" with {
  type: "text",
};
import migration002 from "./migrations/002_memory.sql" with { type: "text" };
import migration003 from "./migrations/003_memory_trigger.sql" with {
  type: "text",
};
import migration004 from "./migrations/004_auth_tables.sql" with {
  type: "text",
};
import migration005 from "./migrations/005_embedding_queue.sql" with {
  type: "text",
};
import { type EngineConfig, resolveConfig, template } from "./template";

interface Migration {
  name: string;
  sql: string;
}

const migrations: Migration[] = [
  { name: "001_updated_at", sql: migration001 },
  { name: "002_memory", sql: migration002 },
  { name: "003_memory_trigger", sql: migration003 },
  { name: "004_auth_tables", sql: migration004 },
  { name: "005_embedding_queue", sql: migration005 },
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

async function assertSchemaOwnership(tx: SQL, schema: string): Promise<void> {
  const [result] = await tx`
    select
      n.nspowner = (select pg_catalog.to_regrole(current_user)::oid) as is_owner
    from pg_catalog.pg_namespace n
    where n.nspname = ${schema}
  `;

  if (!result?.is_owner) {
    throw new Error(
      `Only the owner of the ${schema} schema can run database migrations`,
    );
  }
}

export async function migrateEngine(
  sql: SQL,
  schema: string,
  config: EngineConfig | undefined,
  serverVersion: string,
  shardId?: number,
): Promise<MigrateResult> {
  await assertEngineSchema(sql, schema);
  const resolved = resolveConfig(schema, config);

  return await sql.begin(async (tx) => {
    if (shardId !== undefined) {
      await tx.unsafe(`set local pgdog.shard to ${shardId}`);
    }

    // 1. Acquire advisory lock with retry
    const [{ lock_id }] = await tx`
      select hashtext(${schema})::bigint as lock_id
    `;

    let acquired = false;
    for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
      const [result] = await tx`
        select pg_try_advisory_xact_lock(${lock_id}) as acquired
      `;
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

    // 2. Check ownership
    await assertSchemaOwnership(tx, schema);

    // 3. Check version (reject downgrades)
    const [{ version: dbVersion }] = await tx.unsafe(
      `select version from ${schema}.version`,
    );

    const cmp = semver.order(serverVersion, dbVersion);
    if (cmp < 0) {
      throw new Error(
        `Server version (${serverVersion}) is older than database version (${dbVersion}). ` +
          "Please upgrade the server.",
      );
    }

    // 4. Scaffold migration tracking table
    await tx.unsafe(`
      create table if not exists ${schema}.migration
      ( name text not null primary key
      , applied_at_version text not null
      , applied_at timestamptz not null default pg_catalog.clock_timestamp()
      )
    `);

    // 5. Run migrations
    const sorted = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
    const applied: string[] = [];

    for (const migration of sorted) {
      const [existing] = await tx.unsafe(
        `select 1 from ${schema}.migration where name = $1`,
        [migration.name],
      );

      if (existing) {
        continue;
      }

      const renderedSql = template(migration.sql, resolved);
      await tx.unsafe(renderedSql);
      await tx.unsafe(
        `insert into ${schema}.migration (name, applied_at_version) values ($1, $2)`,
        [migration.name, serverVersion],
      );
      applied.push(migration.name);
    }

    // 6. Update version if app version is newer
    if (cmp > 0) {
      await tx.unsafe(`update ${schema}.version set version = $1, at = now()`, [
        serverVersion,
      ]);
    }

    return { schema, status: "ok" as const, applied };
  });
}

export async function migrateAll(
  sql: SQL,
  schemas: string[],
  config: EngineConfig | undefined,
  serverVersion: string,
  options?: { concurrency?: number; shardId?: number },
): Promise<Map<string, MigrateResult>> {
  const concurrency = options?.concurrency ?? 10;
  const shardId = options?.shardId;
  const results = new Map<string, MigrateResult>();

  // Simple semaphore for bounded parallelism
  let active = 0;
  let idx = 0;

  const runOne = async (schema: string): Promise<void> => {
    try {
      const result = await migrateEngine(
        sql,
        schema,
        config,
        serverVersion,
        shardId,
      );
      results.set(schema, result);
    } catch (error) {
      results.set(schema, {
        schema,
        status: "error",
        applied: [],
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  };

  await new Promise<void>((resolve) => {
    if (schemas.length === 0) {
      resolve();
      return;
    }

    let completed = 0;

    const next = () => {
      while (active < concurrency && idx < schemas.length) {
        const schema = schemas[idx++];
        if (!schema) break;
        active++;
        runOne(schema).then(() => {
          active--;
          completed++;
          if (completed === schemas.length) {
            resolve();
          } else {
            next();
          }
        });
      }
    };

    next();
  });

  return results;
}

export async function dryRun(
  sql: SQL,
  schema: string,
  _config?: EngineConfig,
): Promise<{ pending: string[]; applied: string[] }> {
  await assertEngineSchema(sql, schema);
  const sorted = [...migrations].sort((a, b) => a.name.localeCompare(b.name));

  // Check if migration table exists
  const [{ exists }] = await sql`
    select exists (
      select 1
      from information_schema.tables
      where table_schema = ${schema}
        and table_name = 'migration'
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

export function getMigrations(): ReadonlyArray<{ name: string }> {
  return [...migrations]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name }) => ({ name }));
}

export async function getVersion(sql: SQL, schema: string): Promise<string> {
  await assertEngineSchema(sql, schema);
  const [row] = await sql.unsafe(`select version from ${schema}.version`);
  return row.version;
}
