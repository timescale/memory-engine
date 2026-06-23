import { createHash } from "node:crypto";
import { info, span } from "@pydantic/logfire-node";
import { semver } from "bun";
import type { ISql } from "postgres";
import functionSignatureSql from "./function_signature.sql" with {
  type: "text",
};

// ---------------------------------------------------------------------------
// Shared migration machinery for the core (control plane) and space (data
// plane) migrators. migrateCore / migrateSpace / bootstrapSpaceDatabase are
// thin orchestrators over these helpers. `label` (e.g. "core" / "space") drives
// span names, telemetry attribute keys, and log messages so each migrator keeps
// its existing observability; `dir` is the on-disk path used in SQL-file logs.
// ---------------------------------------------------------------------------

export interface Migration {
  name: string;
  file: string;
  sql: string;
}

export const REQUIRED_EXTENSIONS = [
  { name: "citext", minVersion: "1.6" },
  { name: "ltree", minVersion: "1.3" },
  { name: "vector", minVersion: "0.8.2" },
  { name: "pg_textsearch", minVersion: "1.1.0" },
] as const;

/** A valid lowercase SQL identifier usable as a schema name (<= 63 chars). */
export function isValidSchemaName(schema: string): boolean {
  return /^[a-z_][a-z0-9_]*$/.test(schema) && schema.length <= 63;
}

// ---------------------------------------------------------------------------
// Advisory locking
// ---------------------------------------------------------------------------

const MAX_LOCK_RETRIES = 5;
const BASE_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Derive a stable (int4, int4) advisory-lock key pair from a name. */
export function advisoryLockKey(name: string): [number, number] {
  const digest = createHash("sha256").update(name).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/** Try to take a transaction-scoped advisory lock, with bounded backoff. */
export async function acquireAdvisoryLock(
  tx: ISql,
  key1: number,
  key2: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
    const [result] = await tx`
      select pg_try_advisory_xact_lock(${key1}, ${key2}) as acquired
    `;
    if (result?.acquired) return true;
    if (attempt < MAX_LOCK_RETRIES - 1) {
      await sleep(BASE_DELAY_MS * 2 ** attempt);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Session / precondition helpers
// ---------------------------------------------------------------------------

export interface SessionTimeouts {
  statementTimeout: string;
  lockTimeout: string;
  transactionTimeout: string;
  idleInTransactionSessionTimeout: string;
}

export async function applySessionTimeouts(
  tx: ISql,
  t: SessionTimeouts,
): Promise<void> {
  await tx`select set_config('statement_timeout', ${t.statementTimeout}, true)`;
  await tx`select set_config('lock_timeout', ${t.lockTimeout}, true)`;
  await tx`select set_config('transaction_timeout', ${t.transactionTimeout}, true)`;
  await tx`select set_config('idle_in_transaction_session_timeout', ${t.idleInTransactionSessionTimeout}, true)`;
}

export async function ensurePostgresVersion(tx: ISql): Promise<void> {
  const [row] = await tx`
    select current_setting('server_version_num')::int as server_version_num
  `;
  const serverVersionNum = Number(row?.server_version_num);
  if (serverVersionNum < 180000) {
    throw new Error(
      `PostgreSQL version 18 or higher is required (found ${serverVersionNum})`,
    );
  }
}

export async function ensureExtension(
  tx: ISql,
  name: string,
  minVersion: string,
): Promise<void> {
  // Extensions are database-global, but each migrator (auth, core, the
  // space bootstrap) serializes only against its own advisory key — two
  // DIFFERENT migrators racing on a fresh database both pass the existence
  // check below and the loser's `create extension` dies with a
  // unique_violation (seen with parallel integration suites on a fresh CI
  // container). One database-wide lock serializes every extension ensure;
  // transaction-scoped, so a loser proceeds only after the winner's commit
  // made the extension visible. Re-acquiring within the same transaction
  // (one lock per extension in a migrator's loop) is immediate.
  const [key1, key2] = advisoryLockKey("memory:extensions");
  await tx`select pg_advisory_xact_lock(${key1}, ${key2})`;

  const [installed] = await tx`
    select x.extversion, n.nspname
    from pg_extension x
    inner join pg_namespace n on (x.extnamespace = n.oid)
    where x.extname = ${name}
  `;

  if (installed) {
    if (
      installed.nspname === "public" &&
      semver.order(installed.extversion, minVersion) >= 0
    ) {
      return;
    }
    throw new Error(
      `Extension "${name}" version ${minVersion} or higher is required in the "public" schema (found ${installed.extversion} installed in "${installed.nspname}")`,
    );
  }

  const [available] = await tx`
    select default_version
    from pg_available_extensions
    where name = ${name}
  `;

  if (!available || semver.order(available.default_version, minVersion) < 0) {
    const found = available
      ? `found ${available.default_version} available`
      : "not available";
    throw new Error(
      `Extension "${name}" version ${minVersion} or higher is required (${found})`,
    );
  }

  await tx`create extension if not exists ${tx(name)} with schema public`;
}

/** Ensure every REQUIRED_EXTENSIONS entry, each wrapped in a span. */
export async function ensureRequiredExtensions(
  tx: ISql,
  spanPrefix: string,
): Promise<void> {
  for (const extension of REQUIRED_EXTENSIONS) {
    await span(`${spanPrefix}.ensure_extension`, {
      attributes: {
        "db.extension": extension.name,
        "db.extension_min_version": extension.minVersion,
      },
      callback: () => ensureExtension(tx, extension.name, extension.minVersion),
    });
  }
}

export async function doesSchemaExist(
  tx: ISql,
  schema: string,
): Promise<boolean> {
  const [row] = await tx`
    select exists (
      select 1 from pg_namespace n where n.nspname = ${schema}
    ) as present
  `;
  return Boolean(row?.present);
}

export async function assertSchemaOwnership(
  tx: ISql,
  schema: string,
): Promise<void> {
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

// ---------------------------------------------------------------------------
// Templating
// ---------------------------------------------------------------------------

/**
 * Expand migration-SQL templating, in two passes:
 *
 * 1. `{{fn name(arg, ...) returns result}} … {{endfn}}` blocks. The wrapped
 *    `create or replace function` is emitted verbatim, bracketed by generated
 *    calls to `drop_function_if_signature_differs` (before — drops a definition
 *    whose signature differs, so the create can't hit 42P13 and stale overloads
 *    don't linger) and `assert_function_signature` (after — fails the migration,
 *    including on the fresh schemas CI builds, if the live function doesn't match
 *    the header). The signature is declared once in the header, so the two
 *    generated guards can't drift from each other; the assert catches a
 *    header-vs-definition drift. Write `args` in DROP FUNCTION form — types only,
 *    no parameter names, no typmods (`halfvec`, not `halfvec(1536)`) — to match
 *    `pg_get_function_identity_arguments`.
 *
 * 2. `{{name}}` substitution from `vars` (e.g. `schema`); throws on an unknown
 *    placeholder. Runs after pass 1 so `{{schema}}` inside the generated calls
 *    and the wrapped body is substituted too.
 */
export function template(sql: string, vars: Record<string, unknown>): string {
  const expanded = sql.replace(
    /\{\{fn\s+(\w+)\s*\(([^)]*)\)\s+returns\s+([^}]*?)\s*\}\}([\s\S]*?)\{\{endfn\}\}/g,
    (_, name, args, result, body) => {
      const sig = `'${name.trim()}', '${args.trim()}', '${result.trim()}'`;
      return (
        `select {{schema}}.drop_function_if_signature_differs(${sig});\n` +
        `${body.trim()}\n` +
        `select {{schema}}.assert_function_signature(${sig});`
      );
    },
  );
  return expanded.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) {
      throw new Error(`Missing template variable: ${key}`);
    }
    return String(vars[key]);
  });
}

// ---------------------------------------------------------------------------
// SQL-file execution (with error-location logging)
// ---------------------------------------------------------------------------

export interface SqlFileContext {
  logSqlFiles: boolean;
  label: string;
  schema: string;
  type: string; // "provision" | "incremental" | "idempotent"
  dir: string; // e.g. "packages/database/core/migrate"
  file: string; // e.g. "incremental/001_space.sql"
}

export async function executeSqlFile(
  tx: ISql,
  sqlText: string,
  ctx: SqlFileContext,
): Promise<void> {
  if (ctx.logSqlFiles) {
    console.error(
      `[migrate:db] ${ctx.label} ${ctx.schema} ${ctx.type} ${ctx.dir}/${ctx.file}`,
    );
  }
  try {
    await tx.unsafe(sqlText);
  } catch (error) {
    if (ctx.logSqlFiles) {
      console.error(
        `[migrate:db] failed ${ctx.label} ${ctx.schema} ${ctx.type} ${ctx.dir}/${ctx.file}`,
      );
      logPostgresSqlLocation(sqlText, error);
    }
    throw error;
  }
}

function logPostgresSqlLocation(sqlText: string, error: unknown): void {
  // postgres-js sets `position` (1-based) on server errors; non-PG errors won't.
  const position = Number((error as { position?: unknown })?.position);
  if (!Number.isSafeInteger(position) || position < 1) return;

  const location = sqlLocation(sqlText, position);
  if (!location) return;
  console.error(
    `[migrate:db] sql position ${position} -> line ${location.line}, column ${location.column}`,
  );
  console.error(sqlContext(sqlText, location.line, location.column));
}

function sqlLocation(
  sqlText: string,
  position: number,
): { line: number; column: number } | undefined {
  if (position > sqlText.length + 1) return undefined;
  let line = 1;
  let column = 1;
  for (let i = 0; i < position - 1; i++) {
    if (sqlText.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function sqlContext(sqlText: string, line: number, column: number): string {
  const lines = sqlText.split("\n");
  const start = Math.max(1, line - 2);
  const end = Math.min(lines.length, line + 2);
  const width = String(end).length;
  const output = ["[migrate:db] sql context:"];

  for (let n = start; n <= end; n++) {
    const marker = n === line ? ">" : " ";
    output.push(`${marker} ${String(n).padStart(width)} | ${lines[n - 1]}`);
    if (n === line) {
      output.push(`  ${" ".repeat(width)} | ${" ".repeat(column - 1)}^`);
    }
  }

  return output.join("\n");
}

// ---------------------------------------------------------------------------
// The incremental-once / idempotent-always runner
// ---------------------------------------------------------------------------

export interface RunMigrationsConfig {
  schema: string;
  schemaVersion: string;
  incrementals: Migration[];
  idempotents: Migration[];
  /** Template vars applied to every migration's SQL (always includes `schema`). */
  templateVars: Record<string, unknown>;
  label: string; // "core" | "space"
  dir: string;
  logSqlFiles: boolean;
}

function migrationAttributes(
  label: string,
  schema: string,
  schemaVersion: string,
  migration: Migration,
  type: string,
): Record<string, unknown> {
  return {
    "db.schema": schema,
    [`${label}.migration`]: migration.name,
    [`${label}.migration_file`]: migration.file,
    [`${label}.migration_type`]: type,
    [`${label}.schema_version`]: schemaVersion,
  };
}

/**
 * Assumes the schema's version + migration tracking tables exist (created by
 * provision). Checks ownership, rejects downgrades, applies pending incremental
 * migrations once (tracked), re-applies all idempotent migrations, and stamps
 * the version.
 */
export async function runSchemaMigrations(
  tx: ISql,
  cfg: RunMigrationsConfig,
): Promise<void> {
  const { schema, schemaVersion, label, dir, logSqlFiles, templateVars } = cfg;
  const Label = label.charAt(0).toUpperCase() + label.slice(1);

  await assertSchemaOwnership(tx, schema);

  const [versionRow] = await tx`select version from ${tx(schema)}.version`;
  const dbVersion: string = versionRow?.version;
  const cmp = semver.order(schemaVersion, dbVersion);
  // abort if the application is older than the database
  if (cmp < 0) {
    throw new Error(
      `Application version (${schemaVersion}) is older than database version (${dbVersion}). ` +
        "Please upgrade the application.",
    );
  }
  /* run migrations regardless
  if (cmp === 0) {
    // version matches; no need to run migrations
    info(`${Label} migration skipped, version current`, {
      "db.schema": schema,
      [`${label}.version`]: dbVersion,
      [`${label}.schema_version`]: schemaVersion,
    });
    return;
  }
  */

  // Install the function-signature helper before any migration so incremental
  // and idempotent SQL can call drop_function_if_signature_differs(...) ahead of
  // a `create or replace function` whose signature changed — replacing the
  // hand-written `drop function`/`do $$ ... $$` guards. Idempotent and cheap; see
  // migrate/function_signature.sql.
  await executeSqlFile(tx, template(functionSignatureSql, templateVars), {
    logSqlFiles,
    label,
    schema,
    type: "idempotent",
    dir: "packages/database/migrate",
    file: "function_signature.sql",
  });

  const incrementals = [...cfg.incrementals].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const migration of incrementals) {
    const [existingRow] = await tx`
      select exists (
        select 1 from ${tx(schema)}.migration where name = ${migration.name}
      ) as existing
    `;
    if (existingRow?.existing) continue;

    const attributes = migrationAttributes(
      label,
      schema,
      schemaVersion,
      migration,
      "incremental",
    );
    await span(`${label}.migrate.incremental`, {
      attributes,
      callback: async () => {
        await executeSqlFile(tx, template(migration.sql, templateVars), {
          logSqlFiles,
          label,
          schema,
          type: "incremental",
          dir,
          file: migration.file,
        });
        await tx`
          insert into ${tx(schema)}.migration (name, applied_at_version)
          values (${migration.name}, ${schemaVersion})`;
      },
    });
    info(`${Label} migration applied`, attributes);
  }

  const idempotents = [...cfg.idempotents].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const migration of idempotents) {
    await span(`${label}.migrate.idempotent`, {
      attributes: migrationAttributes(
        label,
        schema,
        schemaVersion,
        migration,
        "idempotent",
      ),
      callback: () =>
        executeSqlFile(tx, template(migration.sql, templateVars), {
          logSqlFiles,
          label,
          schema,
          type: "idempotent",
          dir,
          file: migration.file,
        }),
    });
  }

  await tx`update ${tx(schema)}.version set version = ${schemaVersion}, at = now()`;
}
