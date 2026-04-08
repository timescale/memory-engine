// packages/server/config.ts
// Shared configuration constants

/**
 * Embedding model configuration.
 * All engines use the same embedding model for consistency.
 */
export const embeddingConstants = {
  model: "text-embedding-3-small",
  dimensions: 1536,
} as const;
