import { countTokens, getTokenCounter } from "./tokenizer";
import type { EmbeddingProvider, TruncateResult } from "./types";

// =============================================================================
// Constants
// =============================================================================

/** Tokens reserved for the truncation marker */
const MARKER_TOKENS = 15;

/** Truncation marker appended to truncated text */
const TRUNCATION_MARKER = "\n[truncated]";

/** Adjustment factor for expand/contract iterations */
const ADJUSTMENT_FACTOR = 0.1;

// =============================================================================
// Truncation
// =============================================================================

/**
 * Truncate text to fit within a token limit.
 *
 * Only called for providers with exact tokenizers (OpenAI, Mistral).
 * Providers with API-side truncation (Cohere, Google, Ollama) skip this entirely.
 *
 * Uses a proportional start + linear refinement algorithm:
 * 1. If under limit, return as-is
 * 2. Calculate ratio: targetTokens / currentTokens
 * 3. Start at text.length * ratio
 * 4. Expand/contract by 10% until just under limit
 * 5. Append truncation marker
 */
export function truncateToTokenLimit(
  text: string,
  maxTokens: number,
  provider: EmbeddingProvider,
): TruncateResult {
  const counter = getTokenCounter(provider);

  if (!counter) {
    throw new Error(
      `No exact tokenizer for provider "${provider}". ` +
        `Client-side truncation is only supported for openai and mistral.`,
    );
  }

  const currentTokens = countTokens(text, counter);

  // Under limit — return as-is
  if (currentTokens <= maxTokens) {
    return { text, tokens: currentTokens, truncated: false };
  }

  // Target tokens accounting for marker
  const targetTokens = maxTokens - MARKER_TOKENS;

  // Proportional start + linear refinement
  const ratio = targetTokens / currentTokens;
  let charEstimate = Math.floor(text.length * ratio);

  let truncated = text.slice(0, charEstimate);
  let tokens = countTokens(truncated, counter);

  if (tokens > targetTokens) {
    // Overshoot — shrink until under limit
    while (tokens > targetTokens && charEstimate > 0) {
      charEstimate = Math.floor(charEstimate * (1 - ADJUSTMENT_FACTOR));
      truncated = text.slice(0, charEstimate);
      tokens = countTokens(truncated, counter);
    }
  } else {
    // Undershoot — expand until just under limit
    while (tokens < targetTokens && charEstimate < text.length) {
      const newEstimate = Math.min(
        Math.floor(charEstimate * (1 + ADJUSTMENT_FACTOR)),
        text.length,
      );
      if (newEstimate === charEstimate) break;

      const newTruncated = text.slice(0, newEstimate);
      const newTokens = countTokens(newTruncated, counter);

      if (newTokens > targetTokens) break;

      charEstimate = newEstimate;
      truncated = newTruncated;
      tokens = newTokens;
    }
  }

  const finalText = `${truncated}${TRUNCATION_MARKER}`;
  return {
    text: finalText,
    tokens: countTokens(finalText, counter),
    truncated: true,
  };
}
