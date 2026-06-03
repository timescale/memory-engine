// Main exports

// New core control-plane layer (targets the `core` schema via SQL functions).
// Namespaced to avoid clashing with the legacy formatApiKey/parseApiKey above
// during the migration; consumers use core.createCoreDB, core.parseApiKey, etc.
export * as core from "./core";
export {
  type CreateEngineDBOptions,
  createEngineDB,
  type EngineDB,
} from "./db";
// Re-export migrate module
export * from "./migrate";
// Type exports
export {
  type ApiKey,
  type CreateApiKeyParams,
  type CreateApiKeyResult,
  type CreateMemoryParams,
  type CreateUserParams,
  type GetTreeParams,
  type GrantTreeAccessParams,
  type Memory,
  NotImplementedError,
  type OpsContext,
  type RoleInfo,
  type RoleMember,
  type SearchParams,
  type SearchResult,
  type SearchResultItem,
  type SearchWeights,
  type TemporalFilter,
  type TreeGrant,
  type TreeNode,
  type TreeOwner,
  type UpdateMemoryParams,
  type User,
  type ValidateApiKeyResult,
} from "./types";
// Utility exports
export {
  extractEngineSlug,
  formatApiKey,
  parseApiKey,
} from "./util";
