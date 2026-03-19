// =============================================================================
// Types
// =============================================================================

export type {
  EmbeddingConfig,
  EmbeddingOptions,
  EmbeddingProvider,
  EmbedResult,
  MemoryRow,
} from "./types";

// =============================================================================
// Embedding Generation
// =============================================================================

export {
  generateEmbedding,
  generateEmbeddings,
  type SingleEmbedResult,
  validateConfig,
} from "./generate";

// =============================================================================
// Truncation
// =============================================================================

export {
  DEFAULT_CHARS_PER_TOKEN,
  MAX_OPENAI_TOKENS,
  TRUNCATION_RATIOS,
  type TruncateResult,
  truncateText,
} from "./truncate";
