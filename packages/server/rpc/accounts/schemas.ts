/**
 * Re-export accounts schemas from @memory-engine/protocol.
 *
 * @deprecated Import directly from @memory-engine/protocol/accounts instead.
 */

export {
  type EngineCreateParams,
  type EngineGetParams,
  type EngineListParams,
  type EngineUpdateParams,
  // Engine params
  engineCreateParams as engineCreateSchema,
  engineGetParams as engineGetSchema,
  engineListParams as engineListSchema,
  engineUpdateParams as engineUpdateSchema,
} from "@memory-engine/protocol/accounts/engine";

export {
  type MeGetParams,
  // Identity params
  meGetParams as meGetSchema,
} from "@memory-engine/protocol/accounts/identity";
export {
  type InvitationAcceptParams,
  type InvitationCreateParams,
  type InvitationListParams,
  type InvitationRevokeParams,
  invitationAcceptParams as invitationAcceptSchema,
  // Invitation params
  invitationCreateParams as invitationCreateSchema,
  invitationListParams as invitationListSchema,
  invitationRevokeParams as invitationRevokeSchema,
} from "@memory-engine/protocol/accounts/invitation";

export {
  type OrgCreateParams,
  type OrgDeleteParams,
  type OrgGetParams,
  type OrgListParams,
  type OrgUpdateParams,
  // Org params
  orgCreateParams as orgCreateSchema,
  orgDeleteParams as orgDeleteSchema,
  orgGetParams as orgGetSchema,
  orgListParams as orgListSchema,
  orgUpdateParams as orgUpdateSchema,
} from "@memory-engine/protocol/accounts/org";

export {
  type OrgMemberAddParams,
  type OrgMemberListParams,
  type OrgMemberRemoveParams,
  type OrgMemberUpdateRoleParams,
  orgMemberAddParams as orgMemberAddSchema,
  // Org member params
  orgMemberListParams as orgMemberListSchema,
  orgMemberRemoveParams as orgMemberRemoveSchema,
  orgMemberUpdateRoleParams as orgMemberUpdateRoleSchema,
} from "@memory-engine/protocol/accounts/org-member";
export {
  type SessionRevokeParams,
  // Session params
  sessionRevokeParams as sessionRevokeSchema,
} from "@memory-engine/protocol/accounts/session";
export {
  // Fields
  emailSchema,
  engineStatusSchema,
  nameSchema,
  orgRoleSchema,
  slugSchema,
  uuidv7Schema,
} from "@memory-engine/protocol/fields";
