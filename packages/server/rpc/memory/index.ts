/**
 * Memory RPC method registry — served at `/api/v1/memory/rpc`.
 *
 * The new-model replacement for the engine RPC, combining the memory data-plane
 * methods (spaceStore) with the space management methods (coreStore): membership,
 * groups, tree-access grants, and invitations.
 */
import { AppError } from "../errors";
import type { MethodRegistry } from "../types";
import { accessMethods } from "./access";
import { grantMethods } from "./grant";
import { groupMethods } from "./group";
import { invitationMethods } from "./invitation";
import { memoryDataMethods } from "./memory";
import { principalMethods } from "./principal";
import { activeSpaceMethods } from "./space";
import { assertSpaceRpcContext } from "./types";

export {
  assertSpaceRpcContext,
  isSpaceRpcContext,
  type SpaceRpcContext,
} from "./types";

/**
 * Space-management methods a restricted api key may never call.
 *
 * A restricted key is clamped to the tree access it declares, and
 * `is_principal_space_admin` / `build_tree_access` honor that. But group
 * membership and service-account administration are checked against the bare
 * principal (`is_group_admin`, `is_service_account_admin`), so a restricted key
 * held by a group admin could `group.addMember` and confer the group's grants
 * on anyone — a side door past the clamp. Rather than thread the key into
 * every authority check, deny all authority-changing management to restricted
 * keys outright: a scoped agent key has no business editing membership,
 * grants, or invitations. Read-only lookups (`principal.list/resolve/lookup`,
 * `group.list/listForMember`, `space.listMembers`, `access.effective` on self)
 * stay open since the CLI and MCP server need them.
 */
const RESTRICTED_KEY_DENIED: ReadonlySet<string> = new Set([
  "group.create",
  "group.rename",
  "group.delete",
  "group.setIsSpaceAdmin",
  "group.addMember",
  "group.removeMember",
  "group.listMembers",
  "grant.set",
  "grant.remove",
  "grant.list",
  "principal.add",
  "principal.remove",
  "invite.create",
  "invite.list",
  "invite.revoke",
  "invite.revokeById",
]);

/**
 * Gate the memory registry so every method in {@link RESTRICTED_KEY_DENIED}
 * rejects a restricted-api-key caller. Like the user-RPC gate, the denial is an
 * `authorize` hook (run BEFORE param validation) so the key gets the same
 * `FORBIDDEN` regardless of params and its input is never parsed.
 */
function gateRestrictedKeys(registry: MethodRegistry): MethodRegistry {
  const gated: MethodRegistry = new Map();
  for (const [method, registered] of registry) {
    if (!RESTRICTED_KEY_DENIED.has(method)) {
      gated.set(method, registered);
      continue;
    }
    gated.set(method, {
      ...registered,
      authorize: (ctx) => {
        assertSpaceRpcContext(ctx);
        if (ctx.apiKeyRestricted) {
          throw new AppError(
            "FORBIDDEN",
            "This API key is restricted to its declared space access and cannot manage members, groups, grants, or invitations.",
          );
        }
        registered.authorize?.(ctx);
      },
    });
  }
  return gated;
}

/**
 * The full memory-endpoint registry: data-plane + space management methods.
 * (API keys live on the user endpoint — see rpc/user.)
 */
export const memoryMethods: MethodRegistry = gateRestrictedKeys(
  new Map([
    ...memoryDataMethods,
    ...activeSpaceMethods,
    ...accessMethods,
    ...principalMethods,
    ...groupMethods,
    ...grantMethods,
    ...invitationMethods,
  ]),
);
