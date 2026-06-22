/**
 * One-time prod → multiplayer migration. See PROD_MIGRATION_PLAN.md.
 *
 * `migrateProdToMultiplayer(conns)` runs the whole ETL across the three
 * databases (Phases A+B); `migrateControlPlane`/`migrateEngine` are the per-phase
 * functions. The source databases are never modified, so there is no teardown
 * SQL — rollback is repointing the app at the old databases.
 */

export { mapActionsToLevel, type OldAction, orgRoleIsAdmin } from "./mapping";
export {
  type Connections,
  type EngineReport,
  type MigrateOptions,
  type MigrationReport,
  migrateControlPlane,
  migrateEngine,
  migrateProdToMultiplayer,
} from "./migrate";
export {
  DEFAULT_CONFIG,
  type MigrationConfig,
  prefixed,
  sourceSpaceSchema,
  targetSpaceSchema,
} from "./schemas";
