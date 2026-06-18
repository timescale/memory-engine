import { ACCESS, type AccessLevel } from "@memory.build/engine/core";

/** Old engine grant actions (`me_<slug>.tree_grant.actions`). */
export type OldAction = "read" | "create" | "update" | "delete";

const WRITE_ACTIONS = new Set<string>(["create", "update", "delete"]);

/**
 * Map an old `tree_grant` (its action set + `with_grant_option`) to a single new
 * `tree_access` level. See PROD_MIGRATION_PLAN.md §4.3 — this is intentionally
 * **lossy and over-permissive**:
 *   - `with_grant_option = true` (delegation) → owner (3)
 *   - any of {create, update, delete} present → write (2), which is additive and
 *     therefore also grants read, even if the old grant lacked `read`
 *   - read-only (or, defensively, an empty set) → read (1)
 *
 * The old 4-action granularity has no lossless new representation; a `{delete}`-
 * only or `{read,create}` grant widens to full write. Flagged as a conscious
 * choice; the §9 prod survey checks whether any such non-trivial grants exist.
 */
export function mapActionsToLevel(
  actions: readonly string[],
  withGrantOption: boolean,
): AccessLevel {
  if (withGrantOption) return ACCESS.owner;
  if (actions.some((a) => WRITE_ACTIONS.has(a))) return ACCESS.write;
  return ACCESS.read;
}

/** The org role drives both space-admin and whole-space ownership. */
export type OldOrgRole = "owner" | "admin" | "member";

/** Org owner/admin were engine superusers → space admin + owner@root. */
export function orgRoleIsAdmin(role: string): boolean {
  return role === "owner" || role === "admin";
}
