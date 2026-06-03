import { info, reportError, span } from "@pydantic/logfire-node";
import { semver } from "bun";
import type { Sql as SQL } from "postgres";
import {
  acquireAdvisoryLock,
  advisoryLockKey,
  applySessionTimeouts,
  doesSchemaExist,
  ensureExtension,
  ensurePostgresVersion,
  executeSqlFile,
  isValidSchemaName,
  type Migration,
  runSchemaMigrations,
  template,
} from "../../migrate/kit";
import { AUTH_SCHEMA_VERSION } from "../version";
import idempotent000 from "./idempotent/000_update.sql" with { type: "text" };
import idempotent001 from "./idempotent/001_user.sql" with { type: "text" };
import idempotent002 from "./idempotent/002_session.sql" with { type: "text" };
import idempotent003 from "./idempotent/003_account.sql" with { type: "text" };
import idempotent004 from "./idempotent/004_device_auth.sql" with {
  type: "text",
};
import incremental001 from "./incremental/001_users.sql" with { type: "text" };
import incremental002 from "./incremental/002_accounts.sql" with {
  type: "text",
};
import incremental003 from "./incremental/003_sessions.sql" with {
  type: "text",
};
import incremental004 from "./incremental/004_device_authorization.sql" with {
  type: "text",
};
import incremental005 from "./incremental/005_verifications.sql" with {
  type: "text",
};
import provisionSql from "./provision.sql" with { type: "text" };

const DIR = "packages/database/auth/migrate";

// The auth schema only needs citext (case-insensitive email). It deliberately
// does NOT require the engine extensions (ltree / vector / pg_textsearch), so it
// can live in a database with no pgvector.
const AUTH_REQUIRED_EXTENSIONS = [
  { name: "citext", minVersion: "1.6" },
] as const;

const incrementals: Migration[] = [
  { name: "001_users", file: "incremental/001_users.sql", sql: incremental001 },
  {
    name: "002_accounts",
    file: "incremental/002_accounts.sql",
    sql: incremental002,
  },
  {
    name: "003_sessions",
    file: "incremental/003_sessions.sql",
    sql: incremental003,
  },
  {
    name: "004_device_authorization",
    file: "incremental/004_device_authorization.sql",
    sql: incremental004,
  },
  {
    name: "005_verifications",
    file: "incremental/005_verifications.sql",
    sql: incremental005,
  },
];

const idempotents: Migration[] = [
  { name: "000_update", file: "idempotent/000_update.sql", sql: idempotent000 },
  { name: "001_user", file: "idempotent/001_user.sql", sql: idempotent001 },
  {
    name: "002_session",
    file: "idempotent/002_session.sql",
    sql: idempotent002,
  },
  {
    name: "003_account",
    file: "idempotent/003_account.sql",
    sql: idempotent003,
  },
  {
    name: "004_device_auth",
    file: "idempotent/004_device_auth.sql",
    sql: idempotent004,
  },
];

/**
 * The authentication schema name. Production uses "auth"; the name is a
 * parameter so tests can provision throwaway, isolated auth schemas (and so the
 * SQL is templated symmetrically with the core/space migrations). Reference this
 * constant rather than hardcoding "auth" elsewhere.
 */
export const AUTH_SCHEMA = "auth";

export interface MigrateAuthOptions {
  schema?: string;
  logSqlFiles?: boolean;
  statementTimeout?: string;
  lockTimeout?: string;
  transactionTimeout?: string;
  idleInTransactionSessionTimeout?: string;
}

interface NormalizedMigrateAuthOptions {
  schema: string;
  logSqlFiles: boolean;
  schemaVersion: string;
  statementTimeout: string;
  lockTimeout: string;
  transactionTimeout: string;
  idleInTransactionSessionTimeout: string;
}

export async function migrateAuth(
  sql: SQL,
  options: MigrateAuthOptions = {},
): Promise<void> {
  const opts = normalizeMigrateAuthOptions(options);
  const attributes = migrateAttributes(opts);

  await span("auth.migrate", {
    attributes,
    callback: async () => {
      try {
        if (!isValidSchemaName(opts.schema)) {
          throw new Error(
            `Invalid auth schema name: "${opts.schema}" — must be a valid lowercase SQL identifier (<= 63 chars)`,
          );
        }
        if (!semver.satisfies(opts.schemaVersion, "*")) {
          throw new Error(`Invalid schema version: "${opts.schemaVersion}"`);
        }
        const [key1, key2] = advisoryLockKey(
          `memory-auth:schema:${opts.schema}`,
        );

        await sql.begin(async (tx) => {
          await applySessionTimeouts(tx, opts);
          const acquired = await span("auth.migrate.acquire_lock", {
            attributes,
            callback: () => acquireAdvisoryLock(tx, key1, key2),
          });
          if (!acquired) {
            throw new Error("Unable to acquire lock for auth migrations.");
          }

          await ensurePostgresVersion(tx);
          for (const extension of AUTH_REQUIRED_EXTENSIONS) {
            await span("auth.migrate.ensure_extension", {
              attributes: {
                "db.extension": extension.name,
                "db.extension_min_version": extension.minVersion,
              },
              callback: () =>
                ensureExtension(tx, extension.name, extension.minVersion),
            });
          }

          if (!(await doesSchemaExist(tx, opts.schema))) {
            await span("auth.migrate.provision", {
              attributes: {
                ...attributes,
                "auth.migration_file": "provision.sql",
                "auth.migration_type": "provision",
              },
              callback: () =>
                executeSqlFile(
                  tx,
                  template(provisionSql, { schema: opts.schema }),
                  {
                    logSqlFiles: opts.logSqlFiles,
                    label: "auth",
                    schema: opts.schema,
                    type: "provision",
                    dir: DIR,
                    file: "provision.sql",
                  },
                ),
            });
            info("Auth schema provisioned", attributes);
          }
          await span("auth.migrate.run", {
            attributes,
            callback: () =>
              runSchemaMigrations(tx, {
                schema: opts.schema,
                schemaVersion: opts.schemaVersion,
                incrementals,
                idempotents,
                templateVars: { schema: opts.schema },
                label: "auth",
                dir: DIR,
                logSqlFiles: opts.logSqlFiles,
              }),
          });
        });
        info("Auth migrations completed", attributes);
      } catch (error) {
        reportError("Auth migration failed", error as Error, attributes);
        throw error;
      }
    },
  });
}

function migrateAttributes(
  options: NormalizedMigrateAuthOptions,
): Record<string, unknown> {
  return {
    "db.schema": options.schema,
    "auth.schema_version": options.schemaVersion,
    "auth.required_extensions": AUTH_REQUIRED_EXTENSIONS.map(
      (extension) => `${extension.name}@>=${extension.minVersion}`,
    ),
    "db.statement_timeout": options.statementTimeout,
    "db.lock_timeout": options.lockTimeout,
    "db.transaction_timeout": options.transactionTimeout,
    "db.idle_in_transaction_session_timeout":
      options.idleInTransactionSessionTimeout,
  };
}

function normalizeMigrateAuthOptions(
  options: MigrateAuthOptions,
): NormalizedMigrateAuthOptions {
  return {
    schema: options.schema ?? AUTH_SCHEMA,
    logSqlFiles: options.logSqlFiles ?? false,
    schemaVersion: AUTH_SCHEMA_VERSION,
    statementTimeout: options.statementTimeout ?? "20s",
    lockTimeout: options.lockTimeout ?? "5s",
    transactionTimeout: options.transactionTimeout ?? "1min",
    idleInTransactionSessionTimeout:
      options.idleInTransactionSessionTimeout ?? "5s",
  };
}
