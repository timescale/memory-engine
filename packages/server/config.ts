// packages/server/config.ts
// Shared configuration constants

/**
 * Embedding model configuration.
 * All engines use the same embedding model for consistency.
 *
 * `model` is the default only — it is overridable per-deploy via EMBEDDING_MODEL
 * (see buildEmbeddingConfig), because an OpenAI-compatible gateway may namespace
 * the same underlying model differently (OpenRouter, for instance, serves
 * text-embedding-3-small as "openai/text-embedding-3-small").
 *
 * `dimensions` is deliberately NOT configurable: the memory table's embedding
 * column is halfvec(1536), so a different width would not round-trip. Any
 * replacement model must emit 1536-dim vectors, and it must be embedding-
 * compatible with whatever produced the vectors already stored — mixing models
 * silently degrades semantic search, since stored and query vectors would live
 * in different vector spaces.
 */
export const embeddingConstants = {
  model: "text-embedding-3-small",
  dimensions: 1536,
} as const;
