import { getEncoding, type Tiktoken } from "js-tiktoken";
import mistralTokenizer from "mistral-tokenizer-js";
import type { EmbeddingProvider, TokenCounter } from "./types";

// =============================================================================
// Lazy-loaded Tokenizers (singletons)
// =============================================================================

let openaiTokenizer: Tiktoken | null = null;

// =============================================================================
// Token Counter Factory
// =============================================================================

/**
 * Get a token counter for a specific provider.
 *
 * - OpenAI: Uses js-tiktoken with cl100k_base encoding (exact)
 * - Mistral: Uses mistral-tokenizer-js (exact)
 * - Others: Returns null (use character approximation)
 */
export function getTokenCounter(
  provider: EmbeddingProvider,
): TokenCounter | null {
  switch (provider) {
    case "openai": {
      if (!openaiTokenizer) {
        openaiTokenizer = getEncoding("cl100k_base");
      }
      const tokenizer = openaiTokenizer;
      return { count: (text) => tokenizer.encode(text).length };
    }

    case "mistral": {
      return { count: (text) => mistralTokenizer.encode(text).length };
    }

    default:
      // Ollama, Cohere, Google use various tokenizers (BERT, LLaMA, etc.)
      // No reliable JS tokenizer available — use character approximation
      return null;
  }
}

// =============================================================================
// Token Counting
// =============================================================================

/**
 * Count tokens in text using the provided counter.
 */
export function countTokens(text: string, counter: TokenCounter): number {
  return counter.count(text);
}

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Reset the OpenAI tokenizer singleton. For testing only.
 */
export function _resetTokenizer(): void {
  openaiTokenizer = null;
}
