import { createOpenAI } from "@ai-sdk/openai";
import type { EmbeddingModel } from "ai";
import type { EmbeddingConfig } from "./types";

// =============================================================================
// Provider Factory
// =============================================================================

/**
 * Get an embedding model for the configured provider.
 *
 * Supports: openai, ollama
 *
 * API key resolution:
 * 1. config.apiKey if provided
 * 2. Environment variable: OPENAI_API_KEY
 *
 * Ollama special handling:
 * - Auto-appends /v1 to baseUrl if missing
 * - Uses "ollama" as dummy API key (not required by Ollama)
 */
export function getEmbeddingModel(config: EmbeddingConfig): EmbeddingModel {
  const provider = config.provider.toLowerCase();

  switch (provider) {
    case "openai": {
      const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error(
          `API key not found for OpenAI. Set apiKey in config or OPENAI_API_KEY environment variable.`,
        );
      }
      const openai = createOpenAI({
        apiKey,
        baseURL: config.baseUrl,
      });
      return openai.embedding(config.model);
    }

    case "ollama": {
      // Ollama uses OpenAI-compatible API
      let baseURL = config.baseUrl ?? "http://localhost:11434";
      // Auto-append /v1 if missing
      if (!baseURL.endsWith("/v1")) {
        baseURL = `${baseURL.replace(/\/$/, "")}/v1`;
      }
      const ollama = createOpenAI({
        apiKey: "ollama", // Dummy key required by SDK, ignored by Ollama
        baseURL,
      });
      return ollama.embedding(config.model);
    }

    default:
      throw new Error(
        `Unsupported embedding provider: ${config.provider}. ` +
          `Supported providers: openai, ollama`,
      );
  }
}
