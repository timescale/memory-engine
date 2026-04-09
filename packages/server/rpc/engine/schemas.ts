/**
 * Re-export engine schemas from @memory-engine/protocol.
 *
 * @deprecated Import directly from @memory-engine/protocol/engine instead.
 */

export {
  type ApiKeyCreateParams,
  type ApiKeyDeleteParams,
  type ApiKeyGetParams,
  type ApiKeyListParams,
  type ApiKeyRevokeParams,
  // API Key params
  apiKeyCreateParams as apiKeyCreateSchema,
  apiKeyDeleteParams as apiKeyDeleteSchema,
  apiKeyGetParams as apiKeyGetSchema,
  apiKeyListParams as apiKeyListSchema,
  apiKeyRevokeParams as apiKeyRevokeSchema,
} from "@memory-engine/protocol/engine/api-key";
export {
  type GrantCheckParams,
  type GrantCreateParams,
  type GrantGetParams,
  type GrantListParams,
  type GrantRevokeParams,
  grantCheckParams as grantCheckSchema,
  // Grant params
  grantCreateParams as grantCreateSchema,
  grantGetParams as grantGetSchema,
  grantListParams as grantListSchema,
  grantRevokeParams as grantRevokeSchema,
} from "@memory-engine/protocol/engine/grant";
export {
  type MemoryBatchCreateParams,
  type MemoryCreateParams,
  type MemoryDeleteParams,
  type MemoryDeleteTreeParams,
  type MemoryGetParams,
  type MemoryMoveParams,
  type MemorySearchParams,
  type MemoryTreeParams,
  type MemoryUpdateParams,
  memoryBatchCreateParams as memoryBatchCreateSchema,
  // Memory params
  memoryCreateParams as memoryCreateSchema,
  memoryDeleteParams as memoryDeleteSchema,
  memoryDeleteTreeParams as memoryDeleteTreeSchema,
  memoryGetParams as memoryGetSchema,
  memoryMoveParams as memoryMoveSchema,
  memorySearchParams as memorySearchSchema,
  memoryTreeParams as memoryTreeSchema,
  memoryUpdateParams as memoryUpdateSchema,
} from "@memory-engine/protocol/engine/memory";
export {
  type RoleAddMemberParams,
  type RoleCreateParams,
  type RoleListForUserParams,
  type RoleListMembersParams,
  type RoleRemoveMemberParams,
  roleAddMemberParams as roleAddMemberSchema,
  // Role params
  roleCreateParams as roleCreateSchema,
  roleListForUserParams as roleListForUserSchema,
  roleListMembersParams as roleListMembersSchema,
  roleRemoveMemberParams as roleRemoveMemberSchema,
} from "@memory-engine/protocol/engine/role";
export {
  type UserCreateParams,
  type UserDeleteParams,
  type UserGetByNameParams,
  type UserGetParams,
  type UserListParams,
  type UserRenameParams,
  // User params
  userCreateParams as userCreateSchema,
  userDeleteParams as userDeleteSchema,
  userGetByNameParams as userGetByNameSchema,
  userGetParams as userGetSchema,
  userListParams as userListSchema,
  userRenameParams as userRenameSchema,
} from "@memory-engine/protocol/engine/user";
export {
  // Fields
  grantActionSchema,
  metaSchema,
  searchWeightsSchema,
  temporalFilterSchema,
  temporalSchema,
  timestampSchema,
  treeFilterSchema,
  treePathSchema,
  uuidv7Schema,
} from "@memory-engine/protocol/fields";
