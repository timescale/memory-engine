import { decode, encode } from "gpt-tokenizer/encoding/cl100k_base";

// =============================================================================
// Constants
// =============================================================================

/** Default chars per token for English prose/markdown (~10% buffer) */
export const DEFAULT_CHARS_PER_TOKEN = 3.8;

/** OpenAI embedding model max tokens */
export const MAX_OPENAI_TOKENS = 8191;

/**
 * Window size (characters) for incremental encoding. We encode the text in
 * fixed-size character windows rather than relying on the tokenizer's own
 * whitespace-based segmentation: a long whitespace-free run (e.g. dense CJK or a
 * giant token) is otherwise a single segment that must be BPE-encoded whole —
 * superlinear and ~1s for 20K chars. Bounding each segment to a small window
 * keeps every encode call to ~ms and lets us stop after `maxTokens`. Boundaries
 * cost at most a few extra tokens (lost cross-boundary merges), which only makes
 * truncation marginally more conservative — never over the limit.
 */
const ENCODE_WINDOW_CHARS = 1000;

// =============================================================================
// Types
// =============================================================================

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

function assertPositiveMaxTokens(maxTokens: number): void {
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new Error("maxTokens must be a positive integer");
  }
}

function assertPositiveMaxChars(maxChars: number): void {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error("maxChars must be a positive integer");
  }
}

// =============================================================================
// Safe character floor
// =============================================================================

/**
 * Largest character length that is *guaranteed* to fit within `maxTokens`,
 * so we can skip the tokenizer entirely for small inputs.
 *
 * cl100k_base is a byte-level BPE: every token maps to at least one UTF-8 byte,
 * so `tokens <= utf8ByteLength`. A single UTF-16 code unit encodes to at most
 * 3 UTF-8 bytes (BMP chars like CJK; surrogate pairs are 2 units / 4 bytes =
 * 2 bytes per unit), so `utf8ByteLength <= 3 * text.length` and therefore
 * `tokens <= 3 * text.length`. Anything at or below `maxTokens / 3` characters
 * cannot exceed the token limit.
 */
export function safeCharFloor(maxTokens: number = MAX_OPENAI_TOKENS): number {
  assertPositiveMaxTokens(maxTokens);
  return Math.floor(maxTokens / 3);
}

/** True if `code` is a UTF-16 high surrogate (first unit of a surrogate pair). */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Clip text to a raw UTF-16 character limit without leaving a dangling high
 * surrogate. This is a CPU guard for request-path inputs, not token truncation.
 */
export function clipToCharLimit(text: string, maxChars: number): string {
  assertPositiveMaxChars(maxChars);

  if (text.length <= maxChars) {
    return text;
  }

  let clipped = text.slice(0, maxChars);
  if (isHighSurrogate(clipped.charCodeAt(clipped.length - 1))) {
    clipped = clipped.slice(0, -1);
  }
  return clipped;
}

// =============================================================================
// Character-based truncation (Ollama / defensive)
// =============================================================================

/**
 * Truncate text to fit within a token limit using character estimation.
 *
 * This is an O(1) operation — just checks length and slices. It is an estimate
 * only: for token-dense content (code, JSON, CJK) the real token count can
 * exceed the limit even after slicing. Used for non-OpenAI providers where we
 * don't ship a matching tokenizer; OpenAI uses `truncateToTokenLimit` for an
 * exact bound.
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
  assertPositiveMaxTokens(maxTokens);
  const maxChars = Math.floor(maxTokens * charsPerToken);

  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  return {
    text: text.slice(0, maxChars),
    truncated: true,
  };
}

// =============================================================================
// Exact token-based truncation (OpenAI / cl100k_base)
// =============================================================================

/**
 * Truncate text to an exact token limit using the cl100k_base tokenizer.
 *
 * CPU is bounded to ~`maxTokens` regardless of input size: the text is encoded
 * in fixed-size character windows and we stop as soon as the running token count
 * exceeds the limit, so a 20KB or 20MB input both stop at the cap rather than
 * encoding the whole string. Small inputs (below `safeCharFloor`) skip the
 * tokenizer entirely.
 *
 * This is synchronous CPU work; callers processing batches should yield to the
 * event loop between calls (see `generateEmbeddings`).
 *
 * @param text - The text to truncate
 * @param maxTokens - Maximum tokens allowed (default: 8191 for OpenAI)
 * @returns The (possibly truncated) text and whether truncation occurred
 */
export function truncateToTokenLimit(
  text: string,
  maxTokens: number = MAX_OPENAI_TOKENS,
): TruncateResult {
  assertPositiveMaxTokens(maxTokens);

  // Fast path: short enough that it cannot exceed the token limit.
  if (text.length <= safeCharFloor(maxTokens)) {
    return { text, truncated: false };
  }

  // Encode in fixed-size character windows, stopping as soon as we exceed the
  // limit. This bounds each (synchronous) BPE call and the total work to
  // ~maxTokens, regardless of input size or whitespace.
  const tokens: number[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + ENCODE_WINDOW_CHARS, text.length);
    // Don't split a surrogate pair across windows (would corrupt the char).
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
      end += 1;
    }
    for (const tk of encode(text.slice(i, end))) {
      tokens.push(tk);
    }
    if (
      tokens.length > maxTokens ||
      (tokens.length === maxTokens && end < text.length)
    ) {
      return { text: decode(tokens.slice(0, maxTokens)), truncated: true };
    }
    i = end;
  }

  // Fully consumed without exceeding the limit: return the original bytes.
  return { text, truncated: false };
}
