// =============================================================================
// Provider
// =============================================================================

export type EmbeddingProvider = "openai" | "ollama";

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
  /** Timeout per embedding API call in milliseconds */
  timeoutMs?: number;
  /** Max retries on transient failures */
  maxRetries?: number;
  /** Max concurrent chunk requests when embedding many values (default: Infinity) */
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
