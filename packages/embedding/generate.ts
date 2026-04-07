import { reportError, withSpan } from "@memory-engine/telemetry";
import { embed, embedMany } from "ai";
import { getEmbeddingModel } from "./provider";
import { MAX_OPENAI_TOKENS, TRUNCATION_RATIOS, truncateText } from "./truncate";
import type { EmbeddingConfig, EmbedResult, MemoryRow } from "./types";

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
 *     "type": "invalid_request_error",
 *     "param": null,
 *     "code": null
 *   }
 * }
 */
function isContextLengthError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes("maximum context length");
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
  return withSpan(
    "embedding.generate_once",
    {
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      text_length: text.length,
    },
    async () => {
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
  );
}

// =============================================================================
// Single Embedding (with retry for OpenAI)
// =============================================================================

/**
 * Generate a single embedding for text.
 *
 * Used for search queries where we need to embed the query text.
 *
 * All providers get character-based truncation as a defensive measure.
 * For OpenAI, also retries with progressively tighter ratios (3.0, 2.5)
 * if the initial estimate (3.8 chars/token) isn't aggressive enough.
 *
 * @throws Error if embedding generation fails or dimensions don't match
 */
export async function generateEmbedding(
  text: string,
  config: EmbeddingConfig,
): Promise<SingleEmbedResult> {
  return withSpan(
    "embedding.generate",
    {
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      text_length: text.length,
    },
    async () => {
      const maxTokens = config.options?.maxTokens ?? MAX_OPENAI_TOKENS;

      // Ollama: truncate defensively, single attempt
      if (config.provider !== "openai") {
        const { text: truncated } = truncateText(text, maxTokens);
        return generateEmbeddingOnce(truncated, config);
      }

      // OpenAI: try with progressively tighter truncation ratios
      for (const ratio of TRUNCATION_RATIOS) {
        const { text: truncated } = truncateText(text, maxTokens, ratio);

        try {
          return await generateEmbeddingOnce(truncated, config);
        } catch (error) {
          if (!isContextLengthError(error)) {
            throw error;
          }
          // Context length error — try next ratio
        }
      }

      throw new Error(
        "Failed to embed: text exceeds maximum context length even with aggressive truncation",
      );
    },
  );
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
 * 1. Pre-truncate all texts using character estimate (all providers)
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

  return withSpan(
    "embedding.generate_batch",
    {
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      batch_size: rows.length,
    },
    async () => {
      const model = getEmbeddingModel(config);
      const maxTokens = config.options?.maxTokens ?? MAX_OPENAI_TOKENS;

      // Pre-truncate all providers defensively
      const texts = rows.map(
        (row) => truncateText(row.content, maxTokens).text,
      );

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
        // Report batch error for debugging
        const err =
          batchError instanceof Error
            ? batchError
            : new Error(String(batchError));
        reportError(
          "Batch embedding failed, falling back to individual requests",
          err,
          {
            provider: config.provider,
            model: config.model,
            batch_size: rows.length,
            fallback: "individual",
          },
        );

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
  );
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
  return withSpan(
    "embedding.validate_config",
    {
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
    },
    async () => {
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
  );
}
