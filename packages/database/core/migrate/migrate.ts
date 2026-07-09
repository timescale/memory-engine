import { info, span } from "@pydantic/logfire-node";
import { semver } from "bun";
import type { Sql as SQL } from "postgres";
import {
  acquireAdvisoryLock,
  advisoryLockKey,
  applySessionTimeouts,
  doesSchemaExist,
  ensurePostgresVersion,
  ensureRequiredExtensions,
  executeSqlFile,
  isValidSchemaName,
  type Migration,
  REQUIRED_EXTENSIONS,
  runSchemaMigrations,
  template,
} from "../../migrate/kit";
import { reportError } from "../../telemetry";
import { CORE_SCHEMA_VERSION } from "../version";
import idempotent000 from "./idempotent/000_update.sql" with { type: "text" };
import idempotent001 from "./idempotent/001_principal_space.sql" with {
  type: "text",
};
import idempotent002 from "./idempotent/002_group_member.sql" with {
  type: "text",
};
import idempotent003 from "./idempotent/003_tree_access.sql" with {
  type: "text",
};
import idempotent004 from "./idempotent/004_space.sql" with { type: "text" };
import idempotent005 from "./idempotent/005_principal.sql" with {
  type: "text",
};
import idempotent006 from "./idempotent/006_membership.sql" with {
  type: "text",
};
import idempotent007 from "./idempotent/007_grant.sql" with { type: "text" };
import idempotent008 from "./idempotent/008_api_key.sql" with { type: "text" };
import idempotent009 from "./idempotent/009_invitation.sql" with {
  type: "text",
};
import idempotent010 from "./idempotent/010_default_group.sql" with {
  type: "text",
};
import idempotent011 from "./idempotent/011_service_account.sql" with {
  type: "text",
};
import incremental001 from "./incremental/001_space.sql" with { type: "text" };
import incremental002 from "./incremental/002_principal.sql" with {
  type: "text",
};
import incremental003 from "./incremental/003_principal_space.sql" with {
  type: "text",
};
import incremental004 from "./incremental/004_group_member.sql" with {
  type: "text",
};
import incremental005 from "./incremental/005_tree_access.sql" with {
  type: "text",
};
import incremental006 from "./incremental/006_api_key.sql" with {
  type: "text",
};
import incremental007 from "./incremental/007_space_invitation.sql" with {
  type: "text",
};
import incremental008 from "./incremental/008_principal_name.sql" with {
  type: "text",
};
import incremental009 from "./incremental/009_invitation_links.sql" with {
  type: "text",
};
import incremental010 from "./incremental/010_roster_existing_groups.sql" with {
  type: "text",
};
import incremental011 from "./incremental/011_group_member_space_fk.sql" with {
  type: "text",
};
import incremental012 from "./incremental/012_default_groups.sql" with {
  type: "text",
};
import incremental013 from "./incremental/013_invite_groups.sql" with {
  type: "text",
};
import incremental014 from "./incremental/014_space_access_defaults.sql" with {
  type: "text",
};
import incremental015 from "./incremental/015_service_accounts.sql" with {
  type: "text",
};
import provisionSql from "./provision.sql" with { type: "text" };

const DIR = "packages/database/core/migrate";

const incrementals: Migration[] = [
  { name: "001_space", file: "incremental/001_space.sql", sql: incremental001 },
  {
    name: "002_principal",
    file: "incremental/002_principal.sql",
    sql: incremental002,
  },
  {
    name: "003_principal_space",
    file: "incremental/003_principal_space.sql",
    sql: incremental003,
  },
  {
    name: "004_group_member",
    file: "incremental/004_group_member.sql",
    sql: incremental004,
  },
  {
    name: "005_tree_access",
    file: "incremental/005_tree_access.sql",
    sql: incremental005,
  },
  {
    name: "006_api_key",
    file: "incremental/006_api_key.sql",
    sql: incremental006,
  },
  {
    name: "007_space_invitation",
    file: "incremental/007_space_invitation.sql",
    sql: incremental007,
  },
  {
    name: "008_principal_name",
    file: "incremental/008_principal_name.sql",
    sql: incremental008,
  },
  {
    name: "009_invitation_links",
    file: "incremental/009_invitation_links.sql",
    sql: incremental009,
  },
  {
    name: "010_roster_existing_groups",
    file: "incremental/010_roster_existing_groups.sql",
    sql: incremental010,
  },
  {
    name: "011_group_member_space_fk",
    file: "incremental/011_group_member_space_fk.sql",
    sql: incremental011,
  },
  {
    name: "012_default_groups",
    file: "incremental/012_default_groups.sql",
    sql: incremental012,
  },
  {
    name: "013_invite_groups",
    file: "incremental/013_invite_groups.sql",
    sql: incremental013,
  },
  {
    name: "014_space_access_defaults",
    file: "incremental/014_space_access_defaults.sql",
    sql: incremental014,
  },
  {
    name: "015_service_accounts",
    file: "incremental/015_service_accounts.sql",
    sql: incremental015,
  },
];

const idempotents: Migration[] = [
  { name: "000_update", file: "idempotent/000_update.sql", sql: idempotent000 },
  {
    name: "001_principal_space",
    file: "idempotent/001_principal_space.sql",
    sql: idempotent001,
  },
  {
    name: "002_group_member",
    file: "idempotent/002_group_member.sql",
    sql: idempotent002,
  },
  {
    name: "003_tree_access",
    file: "idempotent/003_tree_access.sql",
    sql: idempotent003,
  },
  { name: "004_space", file: "idempotent/004_space.sql", sql: idempotent004 },
  {
    name: "005_principal",
    file: "idempotent/005_principal.sql",
    sql: idempotent005,
  },
  {
    name: "006_membership",
    file: "idempotent/006_membership.sql",
    sql: idempotent006,
  },
  { name: "007_grant", file: "idempotent/007_grant.sql", sql: idempotent007 },
  {
    name: "008_api_key",
    file: "idempotent/008_api_key.sql",
    sql: idempotent008,
  },
  {
    name: "009_invitation",
    file: "idempotent/009_invitation.sql",
    sql: idempotent009,
  },
  {
    name: "010_default_group",
    file: "idempotent/010_default_group.sql",
    sql: idempotent010,
  },
  {
    name: "011_service_account",
    file: "idempotent/011_service_account.sql",
    sql: idempotent011,
  },
];

/**
 * The core control-plane schema name. Production always uses "core"; the name
 * is a parameter so tests can provision throwaway, isolated cores (and so the
 * SQL is templated symmetrically with the per-space migrations). Reference this
 * constant rather than hardcoding "core" elsewhere.
 */
export const CORE_SCHEMA = "core";

export interface MigrateCoreOptions {
  schema?: string;
  logSqlFiles?: boolean;
  statementTimeout?: string;
  lockTimeout?: string;
  transactionTimeout?: string;
  idleInTransactionSessionTimeout?: string;
}

interface NormalizedMigrateCoreOptions {
  schema: string;
  logSqlFiles: boolean;
  schemaVersion: string;
  statementTimeout: string;
  lockTimeout: string;
  transactionTimeout: string;
  idleInTransactionSessionTimeout: string;
}

export async function migrateCore(
  sql: SQL,
  options: MigrateCoreOptions = {},
): Promise<void> {
  const opts = normalizeMigrateCoreOptions(options);
  const attributes = migrateAttributes(opts);

  await span("core.migrate", {
    attributes,
    callback: async () => {
      try {
        if (!isValidSchemaName(opts.schema)) {
          throw new Error(
            `Invalid core schema name: "${opts.schema}" — must be a valid lowercase SQL identifier (<= 63 chars)`,
          );
        }
        if (!semver.satisfies(opts.schemaVersion, "*")) {
          throw new Error(`Invalid schema version: "${opts.schemaVersion}"`);
        }
        const [key1, key2] = advisoryLockKey(
          `memory-core:schema:${opts.schema}`,
        );

        await sql.begin(async (tx) => {
          await applySessionTimeouts(tx, opts);
          const acquired = await span("core.migrate.acquire_lock", {
            attributes,
            callback: () => acquireAdvisoryLock(tx, key1, key2),
          });
          if (!acquired) {
            throw new Error("Unable to acquire lock for core migrations.");
          }

          await ensurePostgresVersion(tx);
          await ensureRequiredExtensions(tx, "core.migrate");

          if (!(await doesSchemaExist(tx, opts.schema))) {
            await span("core.migrate.provision", {
              attributes: {
                ...attributes,
                "core.migration_file": "provision.sql",
                "core.migration_type": "provision",
              },
              callback: () =>
                executeSqlFile(
                  tx,
                  template(provisionSql, { schema: opts.schema }),
                  {
                    logSqlFiles: opts.logSqlFiles,
                    label: "core",
                    schema: opts.schema,
                    type: "provision",
                    dir: DIR,
                    file: "provision.sql",
                  },
                ),
            });
            info("Core schema provisioned", attributes);
          }
          await span("core.migrate.run", {
            attributes,
            callback: () =>
              runSchemaMigrations(tx, {
                schema: opts.schema,
                schemaVersion: opts.schemaVersion,
                incrementals,
                idempotents,
                templateVars: { schema: opts.schema },
                label: "core",
                dir: DIR,
                logSqlFiles: opts.logSqlFiles,
              }),
          });
        });
        info("Core migrations completed", attributes);
      } catch (error) {
        reportError("Core migration failed", error as Error, attributes);
        throw error;
      }
    },
  });
}

function migrateAttributes(
  options: NormalizedMigrateCoreOptions,
): Record<string, unknown> {
  return {
    "db.schema": options.schema,
    "core.schema_version": options.schemaVersion,
    "core.required_extensions": REQUIRED_EXTENSIONS.map(
      (extension) => `${extension.name}@>=${extension.minVersion}`,
    ),
    "db.statement_timeout": options.statementTimeout,
    "db.lock_timeout": options.lockTimeout,
    "db.transaction_timeout": options.transactionTimeout,
    "db.idle_in_transaction_session_timeout":
      options.idleInTransactionSessionTimeout,
  };
}

function normalizeMigrateCoreOptions(
  options: MigrateCoreOptions,
): NormalizedMigrateCoreOptions {
  return {
    schema: options.schema ?? CORE_SCHEMA,
    logSqlFiles: options.logSqlFiles ?? false,
    schemaVersion: CORE_SCHEMA_VERSION,
    statementTimeout: options.statementTimeout ?? "20s",
    lockTimeout: options.lockTimeout ?? "5s",
    transactionTimeout: options.transactionTimeout ?? "1min",
    idleInTransactionSessionTimeout:
      options.idleInTransactionSessionTimeout ?? "5s",
  };
}
