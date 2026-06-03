// Main exports

// New core control-plane + space data-plane layers (target the core / me_<slug>
// schemas via SQL functions). Namespaced to avoid clashing with the legacy flat
// exports below during the migration: core.createCoreDB, space.createSpaceDB, etc.
export * as core from "./core";
export {
  type CreateEngineDBOptions,
  createEngineDB,
  type EngineDB,
} from "./db";
// Re-export migrate module
export * from "./migrate";
export * as space from "./space";
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
