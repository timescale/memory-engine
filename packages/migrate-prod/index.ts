/**
 * One-time prod → multiplayer migration. See PROD_MIGRATION_PLAN.md.
 *
 * `migrateProdToMultiplayer(sql)` runs the whole ETL in one database (Phases A+B);
 * `dropLegacy`/`dropAccounts` are the explicit post-cutover teardown (Phase C).
 */

export { mapActionsToLevel, type OldAction, orgRoleIsAdmin } from "./mapping";
export {
  dropAccounts,
  dropLegacy,
  type EngineReport,
  type MigrateOptions,
  type MigrationReport,
  migrateControlPlane,
  migrateEngine,
  migrateProdToMultiplayer,
} from "./migrate";
export {
  DEFAULT_SCHEMAS,
  legacySchema,
  type MigrationSchemas,
  prefixed,
  spaceSchema,
} from "./schemas";
