import { createCohere } from "@ai-sdk/cohere";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import type { EmbeddingModel } from "ai";
import type { EmbeddingConfig } from "./types";

// =============================================================================
// Provider Factory
// =============================================================================

/**
 * Get an embedding model for the configured provider.
 *
 * Supports: openai, ollama, cohere, mistral, google
 *
 * API key resolution:
 * 1. config.apiKey if provided
 * 2. Environment variable: {PROVIDER}_API_KEY (e.g., OPENAI_API_KEY)
 *
 * Ollama special handling:
 * - Auto-appends /v1 to baseUrl if missing
 * - Uses "ollama" as dummy API key (not required by Ollama)
 */
export function getEmbeddingModel(
  config: EmbeddingConfig,
): EmbeddingModel<string> {
  const provider = config.provider.toLowerCase();

  // Resolve API key from config or environment
  const envKey = `${provider.toUpperCase()}_API_KEY`;
  const apiKey = config.apiKey ?? process.env[envKey];

  switch (provider) {
    case "openai": {
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

    case "cohere": {
      if (!apiKey) {
        throw new Error(
          `API key not found for Cohere. Set apiKey in config or COHERE_API_KEY environment variable.`,
        );
      }
      const cohere = createCohere({ apiKey });
      return cohere.embedding(config.model);
    }

    case "mistral": {
      if (!apiKey) {
        throw new Error(
          `API key not found for Mistral. Set apiKey in config or MISTRAL_API_KEY environment variable.`,
        );
      }
      const mistral = createMistral({ apiKey });
      return mistral.embedding(config.model);
    }

    case "google": {
      if (!apiKey) {
        throw new Error(
          `API key not found for Google. Set apiKey in config or GOOGLE_API_KEY environment variable.`,
        );
      }
      const google = createGoogleGenerativeAI({ apiKey });
      return google.textEmbeddingModel(config.model);
    }

    default:
      throw new Error(
        `Unsupported embedding provider: ${config.provider}. ` +
          `Supported providers: openai, ollama, cohere, mistral, google`,
      );
  }
}
