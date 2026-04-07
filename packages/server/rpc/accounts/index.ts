import { buildRegistry } from "../registry";
import { engineMethods } from "./engine";
import { invitationMethods } from "./invitation";
import { meMethods } from "./me";
import { orgMethods } from "./org";
import { orgMemberMethods } from "./org-member";

/**
 * Accounts RPC method registry.
 *
 * Identity methods:
 * - me.get
 *
 * Organization methods:
 * - org.create, org.list, org.get, org.update, org.delete
 *
 * Organization member methods:
 * - org.member.list, org.member.add, org.member.remove, org.member.updateRole
 *
 * Engine methods:
 * - engine.create, engine.list, engine.get, engine.update
 *
 * Invitation methods:
 * - invitation.create, invitation.list, invitation.revoke, invitation.accept
 */
export const accountsMethods = buildRegistry()
  .merge(meMethods)
  .merge(orgMethods)
  .merge(orgMemberMethods)
  .merge(engineMethods)
  .merge(invitationMethods)
  .build();

// Re-export types for consumers
export type { AccountsRpcContext } from "./types";
export { assertAccountsRpcContext, isAccountsRpcContext } from "./types";
