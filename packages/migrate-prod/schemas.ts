/**
 * Schema-name configuration for the prod → multiplayer migration.
 *
 * The migration spans THREE databases (see PROD_MIGRATION_PLAN.md §1):
 *   - source `DB_ACCOUNTS`  — identity: the `accounts` schema.
 *   - source `DB_SHARD`     — memories: one `me_<slug>` schema per engine.
 *   - target NEW database   — the new model: `auth` + `core` + per-space `me_<slug>`.
 *
 * Because source and target live in different databases, the per-engine
 * `me_<slug>` name is reused verbatim with no collision. Names are still
 * parameterized so the integration test can stand in ONE physical database for
 * all three connections — there the source and target per-engine schemas must
 * differ, so the source carries a distinct prefix (see `prefixed`).
 */
export interface MigrationConfig {
  /** Source identity schema in DB_ACCOUNTS (templated `accounts`; confirm §9). */
  accountsSchema: string;
  /** Source per-engine schema prefix in DB_SHARD: `<sourceSpacePrefix><slug>`. */
  sourceSpacePrefix: string;
  /** Target better-auth schema in the new DB. */
  authSchema: string;
  /** Target control-plane schema in the new DB. */
  coreSchema: string;
  /** Target per-space schema prefix in the new DB: `<targetSpacePrefix><slug>`. */
  targetSpacePrefix: string;
}

/** Production names: real `accounts`/`me_` sources, real `auth`/`core`/`me_` target. */
export const DEFAULT_CONFIG: MigrationConfig = {
  accountsSchema: "accounts",
  sourceSpacePrefix: "me_",
  authSchema: "auth",
  coreSchema: "core",
  targetSpacePrefix: "me_",
};

/** The OLD per-engine data schema in DB_SHARD: `me_<slug>`. */
export function sourceSpaceSchema(cfg: MigrationConfig, slug: string): string {
  return `${cfg.sourceSpacePrefix}${slug}`;
}

/** The NEW per-space data schema in the target DB: `me_<slug>`. */
export function targetSpaceSchema(cfg: MigrationConfig, slug: string): string {
  return `${cfg.targetSpacePrefix}${slug}`;
}

/**
 * Test config: one physical database stands in for all three connections, so the
 * source and target per-engine schemas must NOT collide — give the source a
 * `shard_me_` prefix and the target the usual `me_`. Production uses
 * `DEFAULT_CONFIG` (the two `me_` prefixes are fine there: different databases).
 */
export function prefixed(prefix: string): MigrationConfig {
  return {
    accountsSchema: `${prefix}accounts`,
    sourceSpacePrefix: `${prefix}shard_me_`,
    authSchema: `${prefix}auth`,
    coreSchema: `${prefix}core`,
    targetSpacePrefix: `${prefix}me_`,
  };
}
