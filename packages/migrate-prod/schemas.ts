/**
 * Schema-name configuration for the prod → multiplayer migration.
 *
 * The whole migration runs **in one database** (see PROD_MIGRATION_PLAN.md §1):
 * the old `accounts` + per-engine `me_<slug>` schemas, and the new `auth` +
 * `core` + per-space `me_<slug>` schemas, all coexist. The only collision is the
 * per-engine `me_<slug>` name, resolved by renaming the old one to
 * `legacy_<slug>` before provisioning the new one (rename-aside).
 *
 * Every name is parameterized via a `prefix` so the integration test can run in
 * throwaway, parallel-safe schemas (the project's standard isolation, which also
 * keeps the suite runnable on ghost where `create database` is forbidden).
 * Production uses an empty prefix → the real `accounts`/`auth`/`core`/`me_`.
 */
export interface MigrationSchemas {
  /** Old identity schema (templated `accounts` in prod; confirm in §9). */
  accounts: string;
  /** New better-auth schema. */
  auth: string;
  /** New control-plane schema. */
  core: string;
  /** Prefix for the per-space data schema: `<spacePrefix><slug>`. */
  spacePrefix: string;
  /** Prefix the old `me_<slug>` engine schema is renamed to before re-provision. */
  legacyPrefix: string;
}

/** Production schema names (empty test prefix). */
export const DEFAULT_SCHEMAS: MigrationSchemas = {
  accounts: "accounts",
  auth: "auth",
  core: "core",
  spacePrefix: "me_",
  legacyPrefix: "legacy_",
};

/** The new (and, before rename, the old) per-engine data schema: `me_<slug>`. */
export function spaceSchema(cfg: MigrationSchemas, slug: string): string {
  return `${cfg.spacePrefix}${slug}`;
}

/** Where the old `me_<slug>` is renamed aside: `legacy_<slug>`. */
export function legacySchema(cfg: MigrationSchemas, slug: string): string {
  return `${cfg.legacyPrefix}${slug}`;
}

/** Apply a test prefix to every schema name (prod uses `prefixed("")`). */
export function prefixed(prefix: string): MigrationSchemas {
  return {
    accounts: `${prefix}accounts`,
    auth: `${prefix}auth`,
    core: `${prefix}core`,
    spacePrefix: `${prefix}me_`,
    legacyPrefix: `${prefix}legacy_`,
  };
}
