/**
 * Space management RPC contract — the control-plane methods served on
 * POST /api/v1/memory/rpc alongside the memory.* data-plane methods.
 *
 * Follows the core model: principals (users/agents/groups), space membership,
 * group membership, 3-level tree-access grants, and agent api keys. (Agent
 * lifecycle is user-scoped and lives on the user endpoint; here agents are only
 * referenced as members / api-key holders.)
 */
import type { z } from "zod";
import {
  apiKeyCreateParams,
  apiKeyCreateResult,
  apiKeyDeleteParams,
  apiKeyDeleteResult,
  apiKeyGetParams,
  apiKeyGetResult,
  apiKeyListParams,
  apiKeyListResult,
} from "./api-key.ts";
import {
  grantListParams,
  grantListResult,
  grantRemoveParams,
  grantRemoveResult,
  grantSetParams,
  grantSetResult,
} from "./grant.ts";
import {
  groupAddMemberParams,
  groupAddMemberResult,
  groupCreateParams,
  groupCreateResult,
  groupDeleteParams,
  groupDeleteResult,
  groupListForMemberParams,
  groupListForMemberResult,
  groupListMembersParams,
  groupListMembersResult,
  groupListParams,
  groupListResult,
  groupRemoveMemberParams,
  groupRemoveMemberResult,
  groupRenameParams,
  groupRenameResult,
} from "./group.ts";
import {
  inviteCreateParams,
  inviteCreateResult,
  inviteListParams,
  inviteListResult,
  inviteRevokeParams,
  inviteRevokeResult,
} from "./invitation.ts";
import {
  principalAddParams,
  principalAddResult,
  principalListParams,
  principalListResult,
  principalLookupParams,
  principalLookupResult,
  principalRemoveParams,
  principalRemoveResult,
  principalResolveParams,
  principalResolveResult,
} from "./principal.ts";

export * from "./api-key.ts";
export * from "./grant.ts";
export * from "./group.ts";
export * from "./invitation.ts";
export * from "./principal.ts";

function method<TParams extends z.ZodType, TResult extends z.ZodType>(
  params: TParams,
  result: TResult,
) {
  return { params, result };
}

/**
 * Space management RPC method contract (member/agent/group/grant/apiKey).
 * Served on the memory endpoint together with the memory.* methods.
 */
export const spaceMethods = {
  // Membership (4) — the space roster holds principals (user | agent | group)
  "principal.list": method(principalListParams, principalListResult),
  "principal.add": method(principalAddParams, principalAddResult),
  "principal.remove": method(principalRemoveParams, principalRemoveResult),
  "principal.resolve": method(principalResolveParams, principalResolveResult),
  "principal.lookup": method(principalLookupParams, principalLookupResult),

  // Groups (8)
  "group.create": method(groupCreateParams, groupCreateResult),
  "group.list": method(groupListParams, groupListResult),
  "group.rename": method(groupRenameParams, groupRenameResult),
  "group.delete": method(groupDeleteParams, groupDeleteResult),
  "group.addMember": method(groupAddMemberParams, groupAddMemberResult),
  "group.removeMember": method(
    groupRemoveMemberParams,
    groupRemoveMemberResult,
  ),
  "group.listMembers": method(groupListMembersParams, groupListMembersResult),
  "group.listForMember": method(
    groupListForMemberParams,
    groupListForMemberResult,
  ),

  // Grants (3)
  "grant.set": method(grantSetParams, grantSetResult),
  "grant.remove": method(grantRemoveParams, grantRemoveResult),
  "grant.list": method(grantListParams, grantListResult),

  // Invitations (3) — email-keyed; adds existing users now, else pending
  "invite.create": method(inviteCreateParams, inviteCreateResult),
  "invite.list": method(inviteListParams, inviteListResult),
  "invite.revoke": method(inviteRevokeParams, inviteRevokeResult),

  // Api keys (4)
  "apiKey.create": method(apiKeyCreateParams, apiKeyCreateResult),
  "apiKey.list": method(apiKeyListParams, apiKeyListResult),
  "apiKey.get": method(apiKeyGetParams, apiKeyGetResult),
  "apiKey.delete": method(apiKeyDeleteParams, apiKeyDeleteResult),
} as const;

export type SpaceMethodName = keyof typeof spaceMethods;
export type SpaceParams<M extends SpaceMethodName> = z.infer<
  (typeof spaceMethods)[M]["params"]
>;
export type SpaceResult<M extends SpaceMethodName> = z.infer<
  (typeof spaceMethods)[M]["result"]
>;
