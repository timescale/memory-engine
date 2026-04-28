import { type SQL, semver } from "bun";
import migration001 from "./migrations/001_updated_at.sql" with {
  type: "text",
};
import migration002 from "./migrations/002_core_tables.sql" with {
  type: "text",
};
import migration003 from "./migrations/003_membership.sql" with {
  type: "text",
};
import migration004 from "./migrations/004_invitations.sql" with {
  type: "text",
};
import migration005 from "./migrations/005_auth.sql" with { type: "text" };
import migration006 from "./migrations/006_ops_support.sql" with {
  type: "text",
};
import migration007 from "./migrations/007_device_authorization.sql" with {
  type: "text",
};
import migration008 from "./migrations/008_drop_org_owner_trigger.sql" with {
  type: "text",
};
import migration009 from "./migrations/009_session_lookup.sql" with {
  type: "text",
};
import { type AccountsConfig, resolveConfig, template } from "./template";

interface Migration {
  name: string;
  sql: string;
}

const migrations: Migration[] = [
  { name: "001_updated_at", sql: migration001 },
  { name: "002_core_tables", sql: migration002 },
  { name: "003_membership", sql: migration003 },
  { name: "004_invitations", sql: migration004 },
  { name: "005_auth", sql: migration005 },
  { name: "006_ops_support", sql: migration006 },
  { name: "007_device_authorization", sql: migration007 },
  { name: "008_drop_org_owner_trigger", sql: migration008 },
  { name: "009_session_lookup", sql: migration009 },
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

/**
 * Scaffold creates the migration infrastructure: schema, version table, migration table.
 * This runs before migrations and is idempotent - safe to call multiple times.
 * Also validates ownership to prevent migrating a schema you don't own.
 */
async function scaffold(tx: SQL, schema: string): Promise<void> {
  await tx.unsafe(`
    do $block$
    declare
        _owner oid;
        _user oid;
    begin
        select pg_catalog.to_regrole(current_user)::oid
        into strict _user
        ;

        select n.nspowner into _owner
        from pg_catalog.pg_namespace n
        where n.nspname = '${schema}'
        ;

        if _owner is null then
            -- schema doesn't exist, create infrastructure
            create schema ${schema};

            -- version table (single row, tracks overall schema version)
            create table ${schema}.version
            ( version text not null check (version ~ '^\\d+\\.\\d+\\.\\d+$')
            , at timestamptz not null default now()
            );
            create unique index on ${schema}.version ((true));
            insert into ${schema}.version (version) values ('0.0.0');

            -- migration table
            create table ${schema}.migration
            ( name text not null primary key
            , applied_at_version text not null
            , applied_at timestamptz not null default pg_catalog.clock_timestamp()
            );

        elsif _owner is distinct from _user then
            raise exception 'only the owner of the ${schema} schema can run database migrations';
        end if
        ;
    end
    $block$
  `);
}

export async function migrate(
  sql: SQL,
  config?: AccountsConfig,
  serverVersion = "0.0.0",
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

    // Scaffold creates schema + version + migration tables (idempotent)
    await scaffold(tx, schema);

    // Check version - reject downgrades
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

    // Run migrations
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

    // Update version if app version is newer
    if (cmp > 0) {
      await tx.unsafe(`update ${schema}.version set version = $1, at = now()`, [
        serverVersion,
      ]);
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
