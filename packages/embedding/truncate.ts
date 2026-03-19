// =============================================================================
// Constants
// =============================================================================

/** Default chars per token for English prose/markdown (~10% buffer) */
export const DEFAULT_CHARS_PER_TOKEN = 3.8;

/** OpenAI embedding model max tokens */
export const MAX_OPENAI_TOKENS = 8191;

/** Retry ratios for progressively tighter truncation on context length errors */
export const TRUNCATION_RATIOS = [3.8, 3.0, 2.5] as const;

// =============================================================================
// Types
// =============================================================================

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

// =============================================================================
// Truncation
// =============================================================================

/**
 * Truncate text to fit within a token limit using character estimation.
 *
 * This is an O(1) operation — just checks length and slices.
 * Uses a conservative chars/token ratio to stay safely under the limit.
 *
 * For English prose/markdown, ~4 chars/token is typical. We use 3.8 by default
 * to provide a ~10% buffer. If the API still returns a context length error,
 * the caller can retry with a lower ratio (3.0, 2.5).
 *
 * @param text - The text to truncate
 * @param maxTokens - Maximum tokens allowed (default: 8191 for OpenAI)
 * @param charsPerToken - Character-to-token ratio (default: 3.8)
 * @returns The (possibly truncated) text and whether truncation occurred
 */
export function truncateText(
  text: string,
  maxTokens: number = MAX_OPENAI_TOKENS,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): TruncateResult {
  const maxChars = Math.floor(maxTokens * charsPerToken);

  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  return {
    text: text.slice(0, maxChars),
    truncated: true,
  };
}
