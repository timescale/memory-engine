/**
 * Re-export accounts schemas from @memory.build/protocol.
 *
 * @deprecated Import directly from @memory.build/protocol/accounts instead.
 */

export {
  type EngineCreateParams,
  type EngineGetParams,
  type EngineListParams,
  type EngineSetupAccessParams,
  type EngineUpdateParams,
  // Engine params
  engineCreateParams as engineCreateSchema,
  engineGetParams as engineGetSchema,
  engineListParams as engineListSchema,
  engineSetupAccessParams as engineSetupAccessSchema,
  engineUpdateParams as engineUpdateSchema,
} from "@memory.build/protocol/accounts/engine";

export {
  type IdentityGetByEmailParams,
  identityGetByEmailParams as identityGetByEmailSchema,
  type MeGetParams,
  // Identity params
  meGetParams as meGetSchema,
} from "@memory.build/protocol/accounts/identity";
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
} from "@memory.build/protocol/accounts/invitation";

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
} from "@memory.build/protocol/accounts/org";

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
} from "@memory.build/protocol/accounts/org-member";
export {
  type SessionRevokeParams,
  // Session params
  sessionRevokeParams as sessionRevokeSchema,
} from "@memory.build/protocol/accounts/session";
export {
  // Fields
  emailSchema,
  engineStatusSchema,
  nameSchema,
  orgRoleSchema,
  uuidv7Schema,
} from "@memory.build/protocol/fields";
