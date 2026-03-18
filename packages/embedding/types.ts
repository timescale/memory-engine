// =============================================================================
// Provider
// =============================================================================

export type EmbeddingProvider =
  | "openai"
  | "ollama"
  | "cohere"
  | "mistral"
  | "google";

// =============================================================================
// Config
// =============================================================================

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  apiKey?: string;
  baseUrl?: string;
  options?: EmbeddingOptions;
}

export interface EmbeddingOptions {
  /** Max tokens per text (truncates longer inputs) */
  maxTokens?: number;
  /** Number of texts per embedding API call */
  batchSize?: number;
  /** Timeout per embedding API call in milliseconds */
  timeoutMs?: number;
  /** Max retries on transient failures */
  maxRetries?: number;
  /** Max concurrent embedding API calls */
  maxParallelCalls?: number;
}

// =============================================================================
// Memory Row
// =============================================================================

export interface MemoryRow {
  id: string;
  content: string;
}

// =============================================================================
// Results
// =============================================================================

export interface EmbedResult {
  id: string;
  embedding: number[];
  /** Tokens consumed by the embedding API call */
  tokens?: number;
  error?: string;
}

export interface TruncateResult {
  text: string;
  tokens: number;
  truncated: boolean;
}

// =============================================================================
// Token Counter
// =============================================================================

export interface TokenCounter {
  count(text: string): number;
}
