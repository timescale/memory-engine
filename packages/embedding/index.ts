// =============================================================================
// Types
// =============================================================================

export type {
  EmbeddingConfig,
  EmbeddingOptions,
  EmbeddingProvider,
  EmbedResult,
  MemoryRow,
  TokenCounter,
  TruncateResult,
} from "./types";

// =============================================================================
// Embedding Generation
// =============================================================================

export {
  generateEmbedding,
  generateEmbeddings,
  validateConfig,
  type SingleEmbedResult,
} from "./generate";

// =============================================================================
// Truncation
// =============================================================================

export { truncateToTokenLimit } from "./truncate";

// =============================================================================
// Token Counting
// =============================================================================

export { countTokens, getTokenCounter } from "./tokenizer";
