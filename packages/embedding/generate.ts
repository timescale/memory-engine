import { embed, embedMany } from "ai";
import { getEmbeddingModel } from "./provider";
import { truncateToTokenLimit } from "./truncate";
import {
  type EmbeddingConfig,
  type EmbedResult,
  type MemoryRow,
  requiresClientTruncation,
} from "./types";

// =============================================================================
// Embed Options
// =============================================================================

interface EmbedOptions {
  maxRetries?: number;
  abortSignal?: AbortSignal;
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

// =============================================================================
// Text Preparation
// =============================================================================

/**
 * Prepare text for embedding, applying truncation if configured.
 */
function prepareText(text: string, config: EmbeddingConfig): string {
  const maxTokens = config.options?.maxTokens;

  if (!maxTokens || !requiresClientTruncation(config.provider)) {
    return text;
  }

  const result = truncateToTokenLimit(text, maxTokens, config.provider);
  return result.text;
}

// =============================================================================
// Provider Options
// =============================================================================

function getProviderOptions(
  config: EmbeddingConfig,
): Record<string, Record<string, string>> | undefined {
  if (config.provider === "cohere") {
    return { cohere: { truncate: "END" } };
  }
  return undefined;
}

// =============================================================================
// Single Embedding
// =============================================================================

export interface SingleEmbedResult {
  embedding: number[];
  /** Tokens consumed by the embedding API call */
  tokens: number;
}

/**
 * Generate a single embedding for text.
 *
 * Used for search queries where we need to embed the query text.
 *
 * @throws Error if embedding generation fails or dimensions don't match
 */
export async function generateEmbedding(
  text: string,
  config: EmbeddingConfig,
): Promise<SingleEmbedResult> {
  const model = getEmbeddingModel(config);
  const preparedText = prepareText(text, config);

  const providerOptions = getProviderOptions(config);
  const result = await embed({
    model,
    value: preparedText,
    ...getEmbedOptions(config),
    ...(providerOptions && { providerOptions }),
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
 * 1. Try batch API (embedMany) first for efficiency
 * 2. On batch failure, fall back to individual requests
 * 3. Errors are captured per-row, not thrown
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

  const model = getEmbeddingModel(config);
  const texts = rows.map((row) => prepareText(row.content, config));
  const providerOptions = getProviderOptions(config);
  const results: EmbedResult[] = [];

  try {
    // Try batch API first
    const { embeddings, usage } = await embedMany({
      model,
      values: texts,
      ...getEmbedOptions(config),
      ...(providerOptions && { providerOptions }),
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
  } catch {
    // Batch failed — fall back to individual requests
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const text = texts[i];
      if (!row || !text) continue;

      try {
        const result = await embed({
          model,
          value: text,
          ...getEmbedOptions(config),
          ...(providerOptions && { providerOptions }),
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
}
