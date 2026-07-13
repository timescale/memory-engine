/**
 * FORBIDDEN-error enrichment: name the space's effective admins.
 *
 * An admin-gated denial is a dead end for a non-admin caller — they can't
 * even discover whom to ask (`principal.list` is admin-only, and
 * `principal.resolve` is targeted lookup, not enumeration). So the server
 * attaches the effective admins' contacts to the denial itself: computed
 * server-side (no caller authority involved), only on a denied attempt, and
 * only ever reaching space members (non-members never pass the auth gate).
 * The CLI renders it as an escalation path ("ask one of: …").
 */
import type { CoreStore } from "@memory.build/engine/core";
import type { AdminContact } from "@memory.build/protocol/errors";
import { AppError } from "./errors";

/**
 * The space's effective admins — direct-member users who are direct admins
 * or direct members of an admin group (`is_principal_space_admin`, the same
 * predicate `enforce_last_admin` counts) — as contacts. Best-effort: the
 * enrichment must never turn a clean denial into an internal error, so any
 * lookup failure resolves to an empty list (the denial then goes out
 * unenriched).
 */
export async function effectiveAdminContacts(
  core: CoreStore,
  spaceId: string,
): Promise<AdminContact[]> {
  try {
    const principals = await core.listSpacePrincipals(spaceId, "u");
    return principals.filter((p) => p.admin).map((p) => ({ email: p.name }));
  } catch {
    return [];
  }
}

/**
 * Build the enriched FORBIDDEN (never throws while enriching — see
 * {@link effectiveAdminContacts}). Callers `throw await forbidden(...)` so
 * control flow stays explicit at the gate.
 */
export async function forbiddenNamingAdmins(
  core: CoreStore,
  spaceId: string,
  message: string,
): Promise<AppError> {
  const admins = await effectiveAdminContacts(core, spaceId);
  return new AppError(
    "FORBIDDEN",
    message,
    admins.length > 0 ? { admins } : undefined,
  );
}
