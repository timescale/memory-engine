import { span, warning } from "@pydantic/logfire-node";
import { embed, embedMany } from "ai";
import {
  extractRetryAfterMs,
  isRateLimitError,
  RateLimitError,
} from "./errors";
import { getEmbeddingModel } from "./provider";
import {
  MAX_OPENAI_TOKENS,
  safeCharFloor,
  truncateText,
  truncateToTokenLimit,
} from "./truncate";
import type { EmbeddingConfig, EmbedResult, MemoryRow } from "./types";

/**
 * Yield to the event loop so a long batch of synchronous tokenization doesn't
 * monopolize the loop (the embedding worker runs in-process with the API
 * server). `setImmediate` runs after pending I/O callbacks, giving requests a
 * chance to be serviced between encodes.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * On a context-length error the API counts more tokens than our truncation
 * targeted (rare edge cases). Re-truncate with a small safety margin below the
 * model limit before the single defensive retry.
 */
const RETRY_TOKEN_MARGIN = 100;

// =============================================================================
// Embed Options
// =============================================================================

interface EmbedOptions {
  maxRetries?: number;
  abortSignal?: AbortSignal;
}

interface EmbedManyOptions extends EmbedOptions {
  maxParallelCalls?: number;
}

function getEmbedOptions(config: EmbeddingConfig): EmbedOptions {
  const options: EmbedOptions = {};

  if (config.options?.maxRetries !== undefined) {
    options.maxRetries = config.options.maxRetries;
  }

  if (config.options?.timeoutMs !== undefined) {
    options.abortSignal = AbortSignal.timeout(config.options.timeoutMs);
  }

  return options;
}

function getEmbedManyOptions(config: EmbeddingConfig): EmbedManyOptions {
  const options: EmbedManyOptions = getEmbedOptions(config);

  if (config.options?.maxParallelCalls !== undefined) {
    options.maxParallelCalls = config.options.maxParallelCalls;
  }

  return options;
}

// =============================================================================
// Error Detection
// =============================================================================

/**
 * Detect if an error is a context length exceeded error from OpenAI.
 *
 * OpenAI returns:
 * {
 *   "error": {
 *     "message": "Invalid 'input': maximum context length is 8192 tokens.",
 *     // or: "Invalid 'input[429]': maximum input length is 8192 tokens."
 *     "type": "invalid_request_error",
 *     "param": null,
 *     "code": null
 *   }
 * }
 */
function isContextLengthError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("maximum context length") ||
      message.includes("maximum input length")
    );
  }
  return false;
}

// =============================================================================
// Single Embedding (internal, no retry)
// =============================================================================

export interface SingleEmbedResult {
  embedding: number[];
  /** Tokens consumed by the embedding API call */
  tokens: number;
}

/**
 * Generate a single embedding without retry logic.
 * Used internally by generateEmbedding.
 */
async function generateEmbeddingOnce(
  text: string,
  config: EmbeddingConfig,
): Promise<SingleEmbedResult> {
  return span("embedding.generate_once", {
    attributes: {
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      text_length: text.length,
    },
    callback: async () => {
      const model = getEmbeddingModel(config);

      const result = await embed({
        model,
        value: text,
        ...getEmbedOptions(config),
      });

      if (result.embedding.length !== config.dimensions) {
        throw new Error(
          `Dimension mismatch: expected ${config.dimensions} but got ${result.embedding.length}`,
        );
      }

      return {
        embedding: result.embedding,
        tokens: result.usage.tokens,
      };
    },
  });
}

// =============================================================================
// Single Embedding (with retry for OpenAI)
// =============================================================================

/**
 * Generate a single embedding for text.
 *
 * Used for search queries where we need to embed the query text.
 *
 * OpenAI gets exact, token-based truncation (cl100k_base) so the input is
 * guaranteed to fit the model limit; other providers get character-based
 * truncation as a defensive measure. On the rare context-length error (the API
 * counting tokens slightly differently), OpenAI retries once after re-truncating
 * with a small safety margin.
 *
 * @throws Error if embedding generation fails or dimensions don't match
 */
export async function generateEmbedding(
  text: string,
  config: EmbeddingConfig,
): Promise<SingleEmbedResult> {
  return span("embedding.generate", {
    attributes: {
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      text_length: text.length,
    },
    callback: async () => {
      const maxTokens = config.options?.maxTokens ?? MAX_OPENAI_TOKENS;

      // Non-OpenAI (e.g. Ollama): char-based defensive truncation, single attempt
      if (config.provider !== "openai") {
        const { text: truncated } = truncateText(text, maxTokens);
        return generateEmbeddingOnce(truncated, config);
      }

      // OpenAI: exact token-based truncation guarantees the input fits.
      const { text: truncated } = truncateToTokenLimit(text, maxTokens);

      try {
        return await generateEmbeddingOnce(truncated, config);
      } catch (error) {
        if (isRateLimitError(error)) {
          throw new RateLimitError(
            "Rate limited by embedding provider",
            extractRetryAfterMs(error),
          );
        }
        if (!isContextLengthError(error)) {
          throw error;
        }

        // Defensive retry: the API counted more tokens than we targeted.
        // Re-truncate below the limit and try once more.
        const { text: retruncated } = truncateToTokenLimit(
          text,
          Math.max(1, maxTokens - RETRY_TOKEN_MARGIN),
        );
        return generateEmbeddingOnce(retruncated, config);
      }
    },
  });
}

// =============================================================================
// Batch Embeddings
// =============================================================================

/**
 * Generate embeddings for multiple memory rows.
 *
 * Used by the embedding worker for background batch processing.
 *
 * Strategy:
 * 1. Pre-truncate all texts — exact token-based for OpenAI, char estimate
 *    otherwise — yielding to the event loop between encodes
 * 2. Try batch API (embedMany) first for efficiency
 * 3. On context length error (OpenAI), fall back to individual requests with retry
 * 4. On other batch failures, fall back to individual requests
 * 5. Errors are captured per-row, not thrown
 *
 * @returns Array of results with embeddings or per-row errors
 */
export async function generateEmbeddings(
  rows: MemoryRow[],
  config: EmbeddingConfig,
): Promise<EmbedResult[]> {
  if (rows.length === 0) {
    return [];
  }

  return span("embedding.generate_batch", {
    attributes: {
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      batch_size: rows.length,
    },
    callback: async () => {
      const model = getEmbeddingModel(config);
      const maxTokens = config.options?.maxTokens ?? MAX_OPENAI_TOKENS;

      // Pre-truncate every row before hitting the API. OpenAI uses exact
      // token-based truncation (cl100k_base); other providers use the char
      // estimate. Tokenization is CPU-bound and this worker runs in-process
      // with the API server, so yield to the event loop between the rows that
      // actually need encoding (small rows skip the tokenizer entirely).
      const floor = safeCharFloor(maxTokens);
      const texts: string[] = [];
      for (const row of rows) {
        if (config.provider === "openai") {
          if (row.content.length > floor) {
            await yieldToEventLoop();
          }
          texts.push(truncateToTokenLimit(row.content, maxTokens).text);
        } else {
          texts.push(truncateText(row.content, maxTokens).text);
        }
      }

      const results: EmbedResult[] = [];

      try {
        // Try batch API first
        const { embeddings, usage } = await embedMany({
          model,
          values: texts,
          ...getEmbedManyOptions(config),
        });

        // embedMany returns aggregate token count — distribute evenly
        const tokensPerRow = Math.floor(usage.tokens / rows.length);

        for (let i = 0; i < rows.length; i++) {
          const embedding = embeddings[i];
          const row = rows[i];
          if (!embedding || !row) continue;

          if (embedding.length !== config.dimensions) {
            results.push({
              id: row.id,
              embedding: [],
              error: `Dimension mismatch: expected ${config.dimensions} but got ${embedding.length}`,
            });
          } else {
            results.push({
              id: row.id,
              embedding,
              tokens: tokensPerRow,
            });
          }
        }
      } catch (batchError) {
        // Rate limit — abort immediately, don't fall back to individual
        // requests (that would amplify load ~10x during a rate limit window)
        if (isRateLimitError(batchError)) {
          throw new RateLimitError(
            "Rate limited by embedding provider",
            extractRetryAfterMs(batchError),
          );
        }

        // Report batch error for debugging
        const err =
          batchError instanceof Error
            ? batchError
            : new Error(String(batchError));
        warning("Batch embedding failed, falling back to individual requests", {
          provider: config.provider,
          model: config.model,
          batch_size: rows.length,
          fallback: "individual",
          error: err.message,
        });

        // On context length error for OpenAI, fall back to individual with retry
        if (config.provider === "openai" && isContextLengthError(batchError)) {
          for (const row of rows) {
            try {
              const result = await generateEmbedding(row.content, config);
              results.push({
                id: row.id,
                embedding: result.embedding,
                tokens: result.tokens,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              results.push({
                id: row.id,
                embedding: [],
                error: message,
              });
            }
          }
          return results;
        }

        // For other batch errors, fall back to individual requests (no retry)
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const text = texts[i];
          if (!row || !text) continue;

          try {
            const result = await embed({
              model,
              value: text,
              ...getEmbedOptions(config),
            });

            if (result.embedding.length !== config.dimensions) {
              results.push({
                id: row.id,
                embedding: [],
                error: `Dimension mismatch: expected ${config.dimensions} but got ${result.embedding.length}`,
              });
            } else {
              results.push({
                id: row.id,
                embedding: result.embedding,
                tokens: result.usage.tokens,
              });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            results.push({
              id: row.id,
              embedding: [],
              error: message,
            });
          }
        }
      }

      return results;
    },
  });
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate embedding configuration by generating a test embedding.
 *
 * Checks:
 * - Provider connection works
 * - Model exists and is accessible
 * - Returned dimensions match configured dimensions
 *
 * @throws Error if validation fails
 */
export async function validateConfig(config: EmbeddingConfig): Promise<void> {
  return span("embedding.validate_config", {
    attributes: {
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
    },
    callback: async () => {
      if (!config.provider) {
        throw new Error("provider is required");
      }
      if (!config.model) {
        throw new Error("model is required");
      }
      if (!config.dimensions || config.dimensions <= 0) {
        throw new Error("dimensions must be a positive number");
      }

      // Generate a test embedding
      const model = getEmbeddingModel(config);

      let result: Awaited<ReturnType<typeof embed>>;
      try {
        result = await embed({
          model,
          value: "test",
          ...getEmbedOptions(config),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to validate embedding config: ${message}`);
      }

      if (result.embedding.length !== config.dimensions) {
        throw new Error(
          `Dimension mismatch: config specifies ${config.dimensions} but model returns ${result.embedding.length}`,
        );
      }
    },
  });
}
