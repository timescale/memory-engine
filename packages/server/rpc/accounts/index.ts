import { buildRegistry } from "../registry";

/**
 * Accounts RPC method registry.
 *
 * Methods will be added in chunk 6:
 * - me.get
 * - org.create, org.list, org.get, org.update, org.delete
 * - org.member.list, org.member.add, org.member.remove, org.member.updateRole
 * - engine.create, engine.list, engine.get, engine.delete
 * - invitation.create, invitation.list, invitation.revoke, invitation.accept
 */
export const accountsMethods = buildRegistry().build();
