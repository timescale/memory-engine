/**
 * User RPC contract served on POST /api/v1/user/rpc. Covers user/account
 * operations, space-scoped service accounts, and global api keys; memory and
 * in-space management live on the memory endpoint.
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
  inviteAcceptParams,
  inviteAcceptResult,
  inviteDeclineParams,
  inviteDeclineResult,
  invitePendingParams,
  invitePendingResult,
  inviteRedeemParams,
  inviteRedeemResult,
} from "./invitation.ts";
import {
  serviceAccountCreateParams,
  serviceAccountCreateResult,
  serviceAccountDeleteParams,
  serviceAccountDeleteResult,
  serviceAccountListParams,
  serviceAccountListResult,
  serviceAccountRenameParams,
  serviceAccountRenameResult,
} from "./service-account.ts";
import {
  spaceCreateParams,
  spaceCreateResult,
  spaceDeleteParams,
  spaceDeleteResult,
  spaceEnsureDefaultParams,
  spaceEnsureDefaultResult,
  spaceListParams,
  spaceListResult,
  spaceRenameParams,
  spaceRenameResult,
} from "./space.ts";
import { whoamiParams, whoamiResult } from "./whoami.ts";

export * from "./api-key.ts";
export * from "./invitation.ts";
export * from "./service-account.ts";
export * from "./space.ts";
export * from "./whoami.ts";

function method<TParams extends z.ZodType, TResult extends z.ZodType>(
  params: TParams,
  result: TResult,
) {
  return { params, result };
}

/**
 * User RPC method contract (identity, service-account lifecycle, api keys, and
 * space discovery).
 */
export const userMethods = {
  whoami: method(whoamiParams, whoamiResult),

  "serviceAccount.create": method(
    serviceAccountCreateParams,
    serviceAccountCreateResult,
  ),
  "serviceAccount.list": method(
    serviceAccountListParams,
    serviceAccountListResult,
  ),
  "serviceAccount.rename": method(
    serviceAccountRenameParams,
    serviceAccountRenameResult,
  ),
  "serviceAccount.delete": method(
    serviceAccountDeleteParams,
    serviceAccountDeleteResult,
  ),

  "apiKey.create": method(apiKeyCreateParams, apiKeyCreateResult),
  "apiKey.list": method(apiKeyListParams, apiKeyListResult),
  "apiKey.get": method(apiKeyGetParams, apiKeyGetResult),
  "apiKey.delete": method(apiKeyDeleteParams, apiKeyDeleteResult),

  "space.list": method(spaceListParams, spaceListResult),
  "space.create": method(spaceCreateParams, spaceCreateResult),
  "space.ensureDefault": method(
    spaceEnsureDefaultParams,
    spaceEnsureDefaultResult,
  ),
  "space.rename": method(spaceRenameParams, spaceRenameResult),
  "space.delete": method(spaceDeleteParams, spaceDeleteResult),

  "invite.pending": method(invitePendingParams, invitePendingResult),
  "invite.accept": method(inviteAcceptParams, inviteAcceptResult),
  "invite.decline": method(inviteDeclineParams, inviteDeclineResult),
  "invite.redeem": method(inviteRedeemParams, inviteRedeemResult),
} as const;

export type UserMethodName = keyof typeof userMethods;
export type UserParams<M extends UserMethodName> = z.infer<
  (typeof userMethods)[M]["params"]
>;
export type UserResult<M extends UserMethodName> = z.infer<
  (typeof userMethods)[M]["result"]
>;
